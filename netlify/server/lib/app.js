import { assertInput, assertRateLimit, bufferResponse, getSessionId, json, LIMITS, text, withConcurrency } from "./guards.js";
import { buildPromptKnowledge, ensureFresh, knowledgeStatus, readCommunityGuide, refreshOfficialSources } from "./knowledge.js";
import { AgyProvider } from "./agy.js";
import { EchoProvider, getProvider, listProviders, registerProvider } from "./providers.js";
import { buildPrompt } from "./prompt.js";
import { runResearch } from "./research.js";
import { getCliVersion } from "./cli-test.js";

registerProvider(new AgyProvider());
registerProvider(new EchoProvider());

let startedAt = null;
let refreshTimer = null;
let researchInFlight = null;
let booting = null;

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

async function prepareChat(req) {
  const sessionId = getSessionId(req);
  assertRateLimit(sessionId);
  const payload = await req.json().catch(() => null);
  const messages = assertInput(payload);
  const provider = getProvider();
  const ready = await provider.available();
  if (!ready.ok) {
    const error = new Error(ready.reason || "The model provider is not available.");
    error.status = 503;
    error.payload = {
      error: ready.reason || "The model provider is not available.",
      hint: "Cove is powered by agy on the machine that runs this dev session. It is not available in a production deploy unless a hosted provider is configured.",
    };
    throw error;
  }
  const knowledge = await buildPromptKnowledge();
  const systemPrompt = buildPrompt({ knowledge: knowledge.text, messages, meta: knowledge });
  return { messages, provider, knowledge, systemPrompt };
}

async function collectReply({ messages, systemPrompt, signal }) {
  let reply = "";
  await withConcurrency(async () => {
    for await (const chunk of getProvider().stream({
      messages,
      systemPrompt,
      signal,
      timeoutMs: LIMITS.chatTimeoutMs,
    })) {
      reply += chunk;
    }
  });
  return reply;
}

async function handleChatStream(req) {
  const prepared = await prepareChat(req);
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (event) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), LIMITS.chatTimeoutMs);
      try {
        enqueue({ type: "status", state: "thinking", provider: prepared.provider.id, knowledgeAt: prepared.knowledge.refreshedAt });
        await withConcurrency(async () => {
          let reply = "";
          for await (const chunk of prepared.provider.stream({
            messages: prepared.messages,
            systemPrompt: prepared.systemPrompt,
            signal: abort.signal,
            timeoutMs: LIMITS.chatTimeoutMs,
          })) {
            reply += chunk;
            enqueue({ type: "token", text: chunk });
          }
          enqueue({ type: "done", text: reply });
        });
      } catch (err) {
        const status = err.status || 500;
        enqueue({ type: "error", error: err.message || "The guide could not answer just now.", status });
      } finally {
        clearTimeout(timer);
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    },
    cancel() {
      closed = true;
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

async function statusPayload() {
  const provider = getProvider();
  const ready = await provider.available();
  const cli = await getCliVersion().catch(() => ({ ok: false, version: null, raw: "" }));
  const knowledge = knowledgeStatus() || (await ensureFresh({ reason: "status", maxAgeMs: 7 * 24 * 60 * 60 * 1000 }).catch(() => null));
  const guide = await readCommunityGuide();
  return {
    ok: true,
    name: "Cove",
    disclaimer: "Fan-made community helper. Not affiliated with Netlify.",
    laptopBound: true,
    note: "Answers are generated by the local provider on the machine running this dev session. A production deploy will need a hosted provider.",
    startedAt,
    provider: { id: provider.id, label: provider.label, available: ready.ok, reason: ready.reason || null },
    providers: listProviders(),
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
      return json({ ok: true, name: "Cove", startedAt });
    }
    if (pathname === "/api/status" && req.method === "GET") {
      return json(await statusPayload());
    }
    if (pathname === "/api/chat" && req.method === "POST") {
      if (wantsStream(req)) return await handleChatStream(req);
      return await handleChatJson(req);
    }
    if (pathname === "/api/knowledge/refresh" && req.method === "POST") {
      const sessionId = getSessionId(req);
      assertRateLimit(sessionId);
      const result = await refreshOfficialSources({ reason: "manual" });
      return json({ ok: true, ...result });
    }
    if (pathname === "/api/research" && req.method === "POST") {
      const sessionId = getSessionId(req);
      assertRateLimit(sessionId);
      if (researchInFlight) {
        return json({ ok: false, error: "A research job is already running." }, 409);
      }
      researchInFlight = runResearch({ includeModelProposals: true }).finally(() => {
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
