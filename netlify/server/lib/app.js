import { assertInput, assertRateLimit, bufferResponse, getSessionId, json, LIMITS, text, withConcurrency } from "./guards.js";
import { buildPromptKnowledge, ensureFresh, knowledgeStatus, readCommunityGuide, refreshOfficialSources } from "./knowledge.js";
import { AgyProvider } from "./agy.js";
import { EchoProvider, getProvider, listProviders, registerProvider, providerCatalog } from "./providers.js";
import { buildPrompt } from "./prompt.js";
import { runResearch } from "./research.js";
import { getCliVersion } from "./cli-test.js";
import { keywordAnalyze, analyzePrompt, parseAnalyzeReply } from "./tags.js";
import { handleNetlifyAccount, accountContextText } from "./netlify-account.js";
import { detectLocalClis } from "./local-clis.js";
import {
  inspectLocalAccess,
  isLocalProviderId,
  localAgentsForbiddenError,
  localAgentsOptedIn,
} from "./local-access.js";

registerProvider(new AgyProvider());
registerProvider(new EchoProvider());

let startedAt = null;
let refreshTimer = null;
let researchInFlight = null;
let booting = null;
let startupLocalAgents = { enabled: false, agy: null, local: [] };

export async function boot() {
  if (startedAt) return startedAt;
  if (booting) return booting;
  booting = (async () => {
    startedAt = new Date().toISOString();
    try {
      await ensureFresh({ reason: "startup" });
    } catch (err) {
      console.error("knowledge startup refresh failed", err);
    }
    if (!refreshTimer) {
      refreshTimer = setInterval(() => {
        ensureFresh({ reason: "schedule" }).catch((err) => console.error("scheduled refresh failed", err));
      }, 6 * 60 * 60 * 1000);
      if (refreshTimer.unref) refreshTimer.unref();
    }
    if (localAgentsOptedIn()) {
      try {
        const agy = new AgyProvider();
        const ready = await agy.available({ localAccess: true });
        const local = await detectLocalClis({ force: true });
        startupLocalAgents = { enabled: true, agy: { ok: !!ready.ok, reason: ready.reason || null }, local };
      } catch (err) {
        startupLocalAgents = { enabled: true, agy: { ok: false, reason: err.message }, local: [] };
        console.error("local agent startup probe failed", err);
      }
    } else {
      startupLocalAgents = { enabled: false, agy: null, local: [] };
    }
    return startedAt;
  })();
  try {
    return await booting;
  } finally {
    booting = null;
  }
}

export async function stop() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

function wantsStream(req) {
  const url = new URL(req.url);
  if (url.searchParams.get("stream") === "0" || url.searchParams.get("stream") === "false") {
    return false;
  }
  const accept = (req.headers.get("accept") || "").toLowerCase();
  if (accept.includes("text/event-stream")) return true;
  if (accept.includes("application/json") && !accept.includes("text/event-stream")) return false;
  return false;
}

function sse(stream) {
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-cache",
      "x-accel-buffering": "no",
    },
  });
}

function takeApiKey(payload) {
  const key = typeof payload?.apiKey === "string" ? payload.apiKey.trim() : "";
  if (!key) return "";
  if (key.length < 8 || key.length > 4096) return "";
  return key;
}

async function prepareChat(req) {
  const sessionId = getSessionId(req);
  assertRateLimit(sessionId);
  const payload = await req.json().catch(() => null);
  const messages = assertInput(payload);
  const access = inspectLocalAccess(req);
  const requested = payload?.provider;
  if (isLocalProviderId(requested) && !access.allowed) {
    throw localAgentsForbiddenError(access);
  }
  const provider = getProvider(requested, { localAccess: access.allowed });
  if (!provider) {
    const error = new Error("Choose a cloud provider and paste your own API key, or sign in with OpenRouter.");
    error.status = 403;
    error.payload = {
      error: "No model provider is available for this request.",
      hint: "Local agents are disabled for public and tunneled requests. Paste your own API key or sign in with OpenRouter.",
      code: "local-agents-forbidden",
    };
    throw error;
  }
  if (isLocalProviderId(provider.id) && !access.allowed) {
    throw localAgentsForbiddenError(access);
  }
  const apiKey = takeApiKey(payload);
  const ready = await provider.available({ apiKey, localAccess: access.allowed });
  if (!ready.ok) {
    const error = new Error(ready.reason || "The model provider is not available.");
    error.status = isLocalProviderId(provider.id) ? 403 : 503;
    error.payload = {
      error: ready.reason || "The model provider is not available.",
      hint: isLocalProviderId(provider.id)
        ? "Paste your own API key or sign in with OpenRouter. Cove will not run local agents for this request."
        : "Paste your own API key for this provider, or sign in with OpenRouter.",
      code: isLocalProviderId(provider.id) ? "local-agents-forbidden" : undefined,
    };
    throw error;
  }
  const knowledge = await buildPromptKnowledge();
  const systemPrompt = buildPrompt({
    knowledge: knowledge.text,
    messages,
    meta: knowledge,
    accountContext: accountContextText(sessionId),
  });
  return { messages, provider, knowledge, systemPrompt, apiKey, localAccess: access.allowed };
}

async function collectReply({ messages, systemPrompt, signal, provider, apiKey, localAccess = false }) {
  let reply = "";
  const active = provider || getProvider(undefined, { localAccess });
  if (!active) {
    const error = new Error("No model provider is available for this request.");
    error.status = 403;
    throw error;
  }
  await withConcurrency(async () => {
    for await (const chunk of active.stream({
      messages,
      systemPrompt,
      apiKey,
      signal,
      timeoutMs: LIMITS.chatTimeoutMs,
      localAccess,
    })) {
      reply += chunk;
    }
  });
  return reply;
}

async function handleChatStream(req) {
  const prepared = await prepareChat(req);
  const encoder = new TextEncoder();
  const abort = new AbortController();
  const onReqAbort = () => abort.abort();
  if (req.signal) {
    if (req.signal.aborted) abort.abort();
    else req.signal.addEventListener("abort", onReqAbort, { once: true });
  }
  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (event) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const timer = setTimeout(() => abort.abort(), LIMITS.chatTimeoutMs);
      try {
        enqueue({ type: "status", state: "thinking", provider: prepared.provider.id, knowledgeAt: prepared.knowledge.refreshedAt });
        await withConcurrency(async () => {
          let reply = "";
          for await (const chunk of prepared.provider.stream({
            messages: prepared.messages,
            systemPrompt: prepared.systemPrompt,
            apiKey: prepared.apiKey,
            signal: abort.signal,
            timeoutMs: LIMITS.chatTimeoutMs,
            localAccess: prepared.localAccess,
          })) {
            reply += chunk;
            enqueue({ type: "token", text: chunk });
          }
          if (!String(reply).trim()) {
            enqueue({ type: "error", error: "The guide returned an empty answer.", status: 502 });
          } else {
            enqueue({ type: "done", text: reply });
          }
        });
      } catch (err) {
        const status = err.status || 500;
        enqueue({ type: "error", error: err.message || "The guide could not answer just now.", status });
      } finally {
        clearTimeout(timer);
        if (req.signal) req.signal.removeEventListener("abort", onReqAbort);
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    },
    cancel() {
      closed = true;
      abort.abort();
      if (req.signal) req.signal.removeEventListener("abort", onReqAbort);
    },
  });
  return sse(stream);
}

async function handleChatJson(req) {
  const prepared = await prepareChat(req);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), LIMITS.chatTimeoutMs);
  try {
    const reply = await collectReply({
      messages: prepared.messages,
      systemPrompt: prepared.systemPrompt,
      signal: abort.signal,
      provider: prepared.provider,
      apiKey: prepared.apiKey,
      localAccess: prepared.localAccess,
    });
    if (!String(reply).trim()) {
      const error = new Error("The guide returned an empty answer.");
      error.status = 502;
      throw error;
    }
    return json({
      ok: true,
      type: "done",
      text: reply,
      provider: prepared.provider.id,
      knowledgeAt: prepared.knowledge.refreshedAt,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function statusPayload(req) {
  const access = inspectLocalAccess(req);
  const provider = getProvider(undefined, { localAccess: access.allowed });
  const ready = provider
    ? await provider.available({ localAccess: access.allowed })
    : { ok: false, reason: "Choose a cloud provider and paste your own API key, or sign in with OpenRouter." };
  const cli = access.allowed
    ? await getCliVersion().catch(() => ({ ok: false, version: null, raw: "" }))
    : { ok: false, version: null, raw: "" };
  const knowledge = knowledgeStatus() || (await ensureFresh({ reason: "status", maxAgeMs: 7 * 24 * 60 * 60 * 1000 }).catch(() => null));
  const guide = await readCommunityGuide();
  return {
    ok: true,
    name: "Cove",
    disclaimer: "Fan-made community helper. Not affiliated with Netlify.",
    laptopBound: access.allowed,
    localAgents: access.allowed,
    note: access.allowed
      ? "Local agents can answer on this machine because this request is local and COVE_LOCAL_AGENTS is enabled."
      : "Local laptop agents are disabled for this request. Paste your own API key or sign in with OpenRouter.",
    startedAt,
    provider: provider
      ? {
          id: provider.id,
          label: provider.label,
          available: ready.ok,
          reason: ready.reason || null,
          bridge: access.allowed ? ready.bridge || null : null,
        }
      : {
          id: null,
          label: null,
          available: false,
          reason: ready.reason,
          bridge: null,
        },
    providers: listProviders({ localAccess: access.allowed }),
    cli: { version: cli.version, ok: cli.ok, raw: (cli.raw || "").split("\n")[0] },
    knowledge: {
      refreshedAt: knowledge?.at || null,
      okCount: knowledge?.okCount || 0,
      sources: (knowledge?.sources || []).map((s) => ({ id: s.id, title: s.title, url: s.url, ok: s.ok, status: s.status })),
      guideChars: guide.length,
      guidePath: "/netlify-ai.md",
    },
  };
}



const analyzeBuckets = new Map();

function assertAnalyzeLimit(sessionId) {
  const now = Date.now();
  let entry = analyzeBuckets.get(sessionId);
  if (!entry || now - entry.start > 10 * 60 * 1000) entry = { start: now, count: 0 };
  if (entry.count >= 20) {
    const err = new Error("analyze-limit");
    err.status = 429;
    throw err;
  }
  entry.count += 1;
  analyzeBuckets.set(sessionId, entry);
}

async function handleAnalyze(req) {
  const sessionId = getSessionId(req);
  const payload = await req.json().catch(() => null);
  const messages = Array.isArray(payload?.messages)
    ? payload.messages.slice(-12).filter((m) => String(m?.content || "").trim())
    : [];
  const fallback = keywordAnalyze(messages);
  if (!messages.length) return json({ ok: true, ...fallback, source: "keywords" });
  try {
    assertAnalyzeLimit(sessionId);
  } catch {
    return json({ ok: true, ...fallback, source: "keywords" });
  }
  const access = inspectLocalAccess(req);
  const provider = getProvider(payload?.provider, { localAccess: access.allowed });
  if (!provider || (isLocalProviderId(provider.id) && !access.allowed)) {
    return json({ ok: true, ...fallback, source: "keywords" });
  }
  const ready = await provider.available({ localAccess: access.allowed });
  if (!ready.ok) return json({ ok: true, ...fallback });
  const { systemPrompt, userContent } = analyzePrompt(messages);
  const combinedPrompt = `${systemPrompt}\n\nConversation:\n${userContent}`;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 25_000);
  try {
    let reply = "";
    for await (const chunk of provider.stream({
      messages: [{ role: "user", content: userContent }],
      systemPrompt: combinedPrompt,
      signal: abort.signal,
      timeoutMs: 25_000,
      localAccess: access.allowed,
    })) {
      reply += chunk;
    }
    return json({ ok: true, ...parseAnalyzeReply(reply, messages) });
  } catch {
    return json({ ok: true, ...fallback });
  } finally {
    clearTimeout(timer);
  }
}

export async function handleRequest(req) {
  await boot();
  const url = new URL(req.url);
  const { pathname } = url;

  if (req.method === "OPTIONS") {
    return bufferResponse(Buffer.alloc(0), 204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, x-cove-session, accept",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    });
  }

  try {
    if (pathname === "/api/health" && req.method === "GET") {
      const access = inspectLocalAccess(req);
      return json({
        ok: true,
        name: "Cove",
        startedAt,
        localAgentsOptedIn: localAgentsOptedIn(),
        localAccessAllowed: access.allowed,
        localAccessReasons: access.allowed ? [] : access.reasons,
      });
    }
    if (pathname === "/api/status" && req.method === "GET") {
      return json(await statusPayload(req));
    }
    if (pathname === "/api/providers" && req.method === "GET") {
      const access = inspectLocalAccess(req);
      return json(await providerCatalog({ localAccess: access.allowed }));
    }
    if (pathname === "/api/chat" && req.method === "POST") {
      if (wantsStream(req)) return await handleChatStream(req);
      return await handleChatJson(req);
    }
    if (pathname === "/api/knowledge/refresh" && req.method === "POST") {
      const access = inspectLocalAccess(req);
      if (!access.allowed) throw localAgentsForbiddenError(access);
      const sessionId = getSessionId(req);
      assertRateLimit(sessionId);
      const result = await refreshOfficialSources({ reason: "manual" });
      return json({ ok: true, ...result });
    }
    if (pathname === "/api/conversations/analyze" && req.method === "POST") {
      return await handleAnalyze(req);
    }
    if (pathname.startsWith("/api/netlify")) {
      const account = await handleNetlifyAccount(req);
      if (account) return account;
    }
    if (pathname === "/api/research" && req.method === "POST") {
      const access = inspectLocalAccess(req);
      if (!access.allowed) throw localAgentsForbiddenError(access);
      const sessionId = getSessionId(req);
      assertRateLimit(sessionId);
      if (researchInFlight) {
        return json({ ok: false, error: "A research job is already running." }, 409);
      }
      researchInFlight = runResearch({ includeModelProposals: access.allowed, localAccess: access.allowed }).finally(() => {
        researchInFlight = null;
      });
      const result = await researchInFlight;
      return json({ ok: true, ...result });
    }
    if (pathname === "/netlify-ai.md" && req.method === "GET") {
      const guide = await readCommunityGuide();
      if (!guide) {
        return text("# Community Netlify AI Guide\n\nThe guide has not been generated yet. Use Research & test in the app.\n", 200, "text/markdown; charset=utf-8");
      }
      return text(guide, 200, "text/markdown; charset=utf-8");
    }
    return json({ error: "Not found" }, 404);
  } catch (err) {
    const status = err.status || 500;
    if (err.payload) return json(err.payload, status);
    return json({ error: err.message || "Unexpected error" }, status);
  }
}
