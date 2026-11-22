/**
 * Cloud model providers. Keys are supplied per request from the browser
 * and must never be logged or written to disk.
 */
import { ProviderError } from "./provider-error.js";
import { LIMITS } from "./guards.js";

function authHeader(apiKey) {
  return { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
}

function extractDelta(ev) {
  if (!ev || typeof ev !== "object") return "";
  if (ev.type === "content_block_delta" || ev.type === "content_block_start") {
    return ev.delta?.text || ev.delta?.content || ev.content_block?.text || "";
  }
  return (
    ev.choices?.[0]?.delta?.content ||
    ev.choices?.[0]?.message?.content ||
    ev.delta?.text ||
    ev.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") ||
    ev.text ||
    ""
  );
}

async function* iterateSse(res) {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const delta = extractDelta(JSON.parse(data));
        if (delta) yield delta;
      } catch {
        /* ignore keep-alives and non-JSON lines */
      }
    }
  }
}

async function readSse(res, onText) {
  let full = "";
  for await (const delta of iterateSse(res)) {
    full += delta;
    if (onText) onText(delta);
  }
  return full;
}

async function fetchJson(url, options, timeoutMs, signal) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs || LIMITS.chatTimeoutMs);
  if (signal) {
    if (signal.aborted) abort.abort();
    else signal.addEventListener("abort", () => abort.abort(), { once: true });
  }
  try {
    const res = await fetch(url, { ...options, signal: abort.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function requireKey(apiKey, name, reason) {
  if (!apiKey) throw new ProviderError(reason || `Add a ${name} API key in Providers.`);
}

export const CLOUD_CATALOG = [
  {
    id: "openrouter",
    label: "OpenRouter",
    auth: "oauth-pkce",
    authLabel: "Official PKCE OAuth — users sign in with OpenRouter and Cove receives an API key billed to their account.",
    docs: "https://openrouter.ai/docs/guides/overview/auth/oauth",
    model: process.env.COVE_OPENROUTER_MODEL || "openrouter/auto",
  },
  {
    id: "openai",
    label: "OpenAI",
    auth: "api-key",
    authLabel: "Bring your own API key. Sign in with ChatGPT can share a user’s plan with approved open-source or partner apps, but Cove is not registered and the public live URL would need partner approval — there is no fake Sign in button here.",
    docs: "https://developers.openai.com/siwc/quickstart",
    keyUrl: "https://platform.openai.com/api-keys",
    model: process.env.COVE_OPENAI_MODEL || "gpt-4o-mini",
  },
  {
    id: "anthropic",
    label: "Anthropic / Claude",
    auth: "api-key",
    authLabel: "Bring your own API key. Claude Platform OAuth is a beta for organization-linked billing, not Claude.ai / Pro / Max subscriptions, and is not available to this app.",
    docs: "https://docs.anthropic.com/",
    keyUrl: "https://console.anthropic.com/settings/keys",
    model: process.env.COVE_ANTHROPIC_MODEL || "claude-sonnet-4-5",
  },
  {
    id: "google",
    label: "Google / Gemini",
    auth: "api-key",
    authLabel: "Bring your own Gemini API key. There is no official way for a third-party app to use a user's Gemini Pro or Ultra subscription via OAuth. Gemini CLI consumer OAuth was discontinued.",
    docs: "https://ai.google.dev/",
    keyUrl: "https://aistudio.google.com/apikey",
    model: process.env.COVE_GEMINI_MODEL || "gemini-2.5-flash",
  },
  {
    id: "xai",
    label: "xAI / Grok",
    auth: "api-key",
    authLabel: "Bring your own API key. Official docs use API keys; there is no clearly documented third-party OAuth program for model inference, so Cove does not fake an X sign-in button.",
    docs: "https://docs.x.ai/",
    keyUrl: "https://console.x.ai/",
    model: process.env.COVE_XAI_MODEL || "grok-3",
  },
];

export function createCloudProvider(entry) {
  return {
    id: entry.id,
    label: entry.label,
    kind: "cloud",
    auth: entry.auth,
    async available({ apiKey } = {}) {
      if (!apiKey) return { ok: false, reason: `Add a ${entry.label} credential in Providers.` };
      return { ok: true };
    },
    async *stream({ systemPrompt, apiKey, signal, timeoutMs }) {
      requireKey(apiKey, entry.label);
      const prompt = String(systemPrompt || "");
      if (entry.id === "anthropic") {
        const res = await fetchJson("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: entry.model,
            max_tokens: 4096,
            system: "You are Cove, a fan-made community Netlify guide.",
            messages: [{ role: "user", content: prompt }],
            stream: true,
          }),
        }, timeoutMs, signal);
        if (!res.ok) throw new ProviderError(`Anthropic returned ${res.status}.`, res.status);
        let produced = false;
        for await (const delta of iterateSse(res)) {
          produced = true;
          yield delta;
        }
        if (!produced) throw new ProviderError("Anthropic returned an empty answer.");
        return;
      }
      if (entry.id === "google") {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(entry.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
        const res = await fetchJson(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }),
        }, timeoutMs, signal);
        if (!res.ok) throw new ProviderError(`Gemini returned ${res.status}.`, res.status);
        let produced = false;
        for await (const delta of iterateSse(res)) {
          produced = true;
          yield delta;
        }
        if (!produced) throw new ProviderError("Gemini returned an empty answer.");
        return;
      }
      const url = entry.id === "openai"
        ? "https://api.openai.com/v1/chat/completions"
        : entry.id === "xai"
          ? "https://api.x.ai/v1/chat/completions"
          : "https://openrouter.ai/api/v1/chat/completions";
      const headers = authHeader(apiKey);
      if (entry.id === "openrouter") {
        headers["HTTP-Referer"] = "https://cove--cove-netlify-bot.netlify.live";
        headers["X-Title"] = "Cove";
      }
      const res = await fetchJson(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: entry.model,
          stream: true,
          messages: [
            { role: "system", content: "You are Cove, a fan-made community Netlify guide." },
            { role: "user", content: prompt },
          ],
        }),
      }, timeoutMs, signal);
      if (!res.ok) throw new ProviderError(`${entry.label} returned ${res.status}.`, res.status);
      let produced = false;
      for await (const delta of iterateSse(res)) {
        produced = true;
        yield delta;
      }
      if (!produced) throw new ProviderError(`${entry.label} returned an empty answer.`);
    },
  };
}
