import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

// Isolate account store BEFORE importing server modules so we never touch logs/cove-account-sessions.json
const tempDir = mkdtempSync(join(tmpdir(), "cove-test-"));
const tempStorePath = join(tempDir, "account-sessions.json");
process.env.COVE_ACCOUNT_STORE_PATH = tempStorePath;
process.env.COVE_PUBLIC_ORIGIN = "https://cove--cove-netlify-bot.netlify.live";
process.env.NETLIFY_OAUTH_CLIENT_ID = "test-oauth-client-id";
process.env.NETLIFY_OAUTH_CLIENT_SECRET = "test-oauth-client-secret";
process.env.NETLIFY_CLI_OAUTH_CLIENT_ID = "test-cli-client-id";

const { handleRequest } = await import("../netlify/server/lib/app.js");
const coveFunction = (await import("../netlify/functions/cove.js")).default;
const { registerProvider, getProvider } = await import("../netlify/server/lib/providers.js");
const { CLOUD_CATALOG, createCloudProvider, extractDelta, iterateSse } = await import("../netlify/server/lib/cloud-providers.js");
const { keywordAnalyze, parseAnalyzeReply, TAGS } = await import("../netlify/server/lib/tags.js");
const { accountContextText } = await import("../netlify/server/lib/netlify-account.js");

test.after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeSseResponse(chunks) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

test("chat: /api/chat?stream=0 fallback returns JSON with echo provider", async () => {
  const req = new Request("http://127.0.0.1:8971/api/chat?stream=0", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cove-session": "test_session_json_1",
      accept: "application/json",
    },
    body: JSON.stringify({
      provider: "echo",
      messages: [{ role: "user", content: "Explain netlify.toml redirects" }],
    }),
  });
  const res = await coveFunction(req);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-length"));
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.provider, "echo");
  assert.match(data.text, /Explain netlify\.toml redirects/);
});

test("chat: /api/chat SSE streams status, tokens, and done events", async () => {
  const req = new Request("http://127.0.0.1:8971/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cove-session": "test_session_sse_1",
      accept: "text/event-stream",
    },
    body: JSON.stringify({
      provider: "echo",
      messages: [{ role: "user", content: "Hello streaming Cove" }],
    }),
  });
  const res = await coveFunction(req);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
  const raw = await res.text();
  const events = raw
    .split("\n\n")
    .filter((b) => b.startsWith("data:"))
    .map((b) => JSON.parse(b.slice(5).trim()));
  assert.equal(events[0].type, "status");
  assert.ok(events.some((e) => e.type === "token"));
  const done = events.find((e) => e.type === "done");
  assert.ok(done);
  assert.match(done.text, /Hello streaming Cove/);
});

test("chat: stream cancellation aborts provider signal", async () => {
  let aborted = false;
  registerProvider({
    id: "test-cancel",
    label: "Test Cancel",
    kind: "test",
    async available() {
      return { ok: true };
    },
    async *stream({ signal }) {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      yield "first ";
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 5000);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        });
      });
    },
  });

  const req = new Request("http://127.0.0.1:8971/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cove-session": "test_session_cancel",
      accept: "text/event-stream",
    },
    body: JSON.stringify({
      provider: "test-cancel",
      messages: [{ role: "user", content: "Cancel me" }],
    }),
  });
  const res = await handleRequest(req);
  const reader = res.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(aborted, true);
});

test("chat: missing cloud API key returns 503 with clear error", async () => {
  for (const id of ["openrouter", "openai", "anthropic", "google", "xai"]) {
    const req = new Request("http://127.0.0.1:8971/api/chat?stream=0", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cove-session": `test_nokey_${id}`,
      },
      body: JSON.stringify({
        provider: id,
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    const res = await handleRequest(req);
    assert.equal(res.status, 503, `expected 503 for ${id} without key`);
    const data = await res.json();
    assert.match(data.error, /credential/i);
  }
});

test("cloud-providers: iterateSse handles LF, CRLF (Gemini), Anthropic, OpenAI/xAI/OpenRouter, and trailing EOF buffer", async () => {
  // OpenAI / xAI / OpenRouter format
  const openaiRes = makeSseResponse([
    'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  let out = "";
  for await (const d of iterateSse(openaiRes)) out += d;
  assert.equal(out, "Hello world");

  // Anthropic format with CRLF
  const claudeRes = makeSseResponse([
    'event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"text":"Claude "}}\r\n\r\n',
    'event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"text":"works"}}\r\n\r\n',
  ]);
  out = "";
  for await (const d of iterateSse(claudeRes)) out += d;
  assert.equal(out, "Claude works");

  // Google Gemini format with CRLF AND no trailing blank line at EOF
  const geminiRes = makeSseResponse([
    'data: {"candidates":[{"content":{"parts":[{"text":"Gemini "}]}}]}\r\n\r\n',
    'data: {"candidates":[{"content":{"parts":[{"text":"streaming"}]}}]}',
  ]);
  out = "";
  for await (const d of iterateSse(geminiRes)) out += d;
  assert.equal(out, "Gemini streaming");

  assert.equal(extractDelta({ choices: [{ delta: { content: "x" } }] }), "x");
});

test("cloud-providers: upstream errors surface sanitized message without leaking API key", async () => {
  const realFetch = globalThis.fetch;
  const fakeKey = "sk-test-secret-key-999999999";
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: "Incorrect API key provided" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });

    for (const entry of CLOUD_CATALOG) {
      const provider = createCloudProvider(entry);
      await assert.rejects(
        async () => {
          for await (const _ of provider.stream({ systemPrompt: "hi", apiKey: fakeKey })) {
            /* noop */
          }
        },
        (err) => {
          assert.equal(err.status, 401);
          assert.match(err.message, /401/);
          assert.match(err.message, /Incorrect API key provided/);
          assert.ok(!err.message.includes(fakeKey), "API key must never appear in error");
          return true;
        },
      );
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("conversations auto-analysis: keywordAnalyze, parseAnalyzeReply, and handleAnalyze prompt inclusion", async () => {
  const kw = keywordAnalyze([
    { role: "user", content: "My netlify.toml redirect 301 is giving a 500 error in netlify dev" },
  ]);
  assert.ok(kw.tags.includes("Redirects"));
  assert.ok(kw.tags.includes("CLI"));
  assert.ok(kw.tags.includes("Debugging"));
  assert.equal(kw.source, "keywords");

  const parsed = parseAnalyzeReply('{"title":"Fixing 301 redirects in netlify.toml","tags":["Redirects","InvalidTag","CLI"]}', []);
  assert.equal(parsed.title, "Fixing 301 redirects in netlify.toml");
  assert.deepEqual(parsed.tags, ["Redirects", "CLI"]);
  assert.equal(parsed.source, "model");
  assert.ok(TAGS.includes("Server"));

  // Verify handleAnalyze passes conversation text in systemPrompt to the active provider
  let capturedSystemPrompt = "";
  const prevProvider = process.env.COVE_PROVIDER;
  registerProvider({
    id: "test-analyze",
    label: "Test Analyze",
    kind: "test",
    async available() {
      return { ok: true };
    },
    async *stream({ systemPrompt }) {
      capturedSystemPrompt = systemPrompt;
      yield '{"title":"Netlify Blobs store setup","tags":["Blobs"]}';
    },
  });
  process.env.COVE_PROVIDER = "test-analyze";
  try {
    const req = new Request("http://127.0.0.1:8971/api/conversations/analyze", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cove-session": "test_analyze_1" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "How do I use getStore with Netlify Blobs?" }],
      }),
    });
    const res = await handleRequest(req);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.match(capturedSystemPrompt, /getStore with Netlify Blobs/);
    assert.equal(data.title, "Netlify Blobs store setup");
    assert.deepEqual(data.tags, ["Blobs"]);
    assert.equal(data.source, "model");

    // Empty messages should return immediately without calling provider
    capturedSystemPrompt = "";
    const emptyReq = new Request("http://127.0.0.1:8971/api/conversations/analyze", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cove-session": "test_analyze_1" },
      body: JSON.stringify({ messages: [] }),
    });
    const emptyRes = await handleRequest(emptyReq);
    const emptyData = await emptyRes.json();
    assert.equal(capturedSystemPrompt, "");
    assert.equal(emptyData.source, "keywords");
  } finally {
    if (prevProvider === undefined) delete process.env.COVE_PROVIDER;
    else process.env.COVE_PROVIDER = prevProvider;
  }
});

test("netlify account: CLI ticket flow, Web OAuth flow, token flow, persistence, and disconnect", async () => {
  const realFetch = globalThis.fetch;
  const sessionId = "test_netlify_sess_1";
  let lastTokenBody = "";

  try {
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes("/oauth/tickets?client_id=")) {
        return new Response(JSON.stringify({ id: "tkt_123" }), { status: 200 });
      }
      if (u.endsWith("/oauth/tickets/tkt_123")) {
        return new Response(JSON.stringify({ id: "tkt_123", authorized: true }), { status: 200 });
      }
      if (u.endsWith("/oauth/tickets/tkt_123/exchange")) {
        return new Response(JSON.stringify({ access_token: "nfp_test_cli_token_1234567890" }), { status: 200 });
      }
      if (u === "https://api.netlify.com/oauth/token") {
        lastTokenBody = String(init.body || "");
        return new Response(JSON.stringify({ access_token: "nfp_test_oauth_token_1234567890" }), { status: 200 });
      }
      if (u.endsWith("/api/v1/user")) {
        return new Response(JSON.stringify({ id: "u1", full_name: "Test User", email: "test@example.com" }), { status: 200 });
      }
      if (u.includes("/api/v1/sites")) {
        return new Response(
          JSON.stringify([
            {
              id: "s1",
              name: "cove-demo",
              ssl_url: "https://cove-demo.netlify.app",
              published_deploy: { state: "ready", published_at: "2026-11-23T12:00:00Z" },
            },
          ]),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch URL in test: ${u}`);
    };

    // 1. Unauthenticated status
    const statusRes = await handleRequest(new Request("http://127.0.0.1:8971/api/netlify/status"));
    const statusData = await statusRes.json();
    assert.equal(statusData.linked, false);
    assert.equal(statusData.oauthConfigured, true);
    assert.equal(statusData.redirectUri, "https://cove--cove-netlify-bot.netlify.live/api/netlify/oauth/callback");

    // 2. CLI ticket request + check
    const reqTicket = await handleRequest(
      new Request("http://127.0.0.1:8971/api/netlify/cli/request", {
        method: "POST",
        headers: { "x-cove-session": sessionId },
      }),
    );
    const ticketData = await reqTicket.json();
    assert.equal(ticketData.ok, true);
    assert.equal(ticketData.ticketId, "tkt_123");
    assert.match(ticketData.url, /response_type=ticket/);

    const checkRes = await handleRequest(
      new Request(`http://127.0.0.1:8971/api/netlify/cli/check?ticket=${ticketData.ticketId}`, {
        headers: { "x-cove-session": sessionId },
      }),
    );
    const checkData = await checkRes.json();
    assert.equal(checkData.status, "authorized");
    assert.equal(checkData.linked, true);
    assert.equal(checkData.sites.length, 1);
    assert.ok(existsSync(tempStorePath), "session store should persist to disk");

    // Account context includes site info and never includes the token
    const ctx = accountContextText(sessionId);
    assert.match(ctx, /cove-demo/);
    assert.ok(!ctx.includes("nfp_test_cli_token"));

    // 3. Disconnect
    const discRes = await handleRequest(
      new Request("http://127.0.0.1:8971/api/netlify/disconnect", {
        method: "POST",
        headers: { "x-cove-session": sessionId },
      }),
    );
    assert.equal((await discRes.json()).linked, false);

    // 4. Web OAuth start + denied callback + valid callback
    const startRes = await handleRequest(
      new Request("http://127.0.0.1:8971/api/netlify/oauth/start", {
        method: "POST",
        headers: { "x-cove-session": sessionId },
      }),
    );
    const startData = await startRes.json();
    assert.equal(startData.ok, true);
    const authUrl = new URL(startData.url);
    const state = authUrl.searchParams.get("state");
    assert.ok(state);
    assert.equal(
      authUrl.searchParams.get("redirect_uri"),
      "https://cove--cove-netlify-bot.netlify.live/api/netlify/oauth/callback",
    );

    // Callback with error=access_denied
    const startRes2 = await handleRequest(
      new Request("http://127.0.0.1:8971/api/netlify/oauth/start", {
        method: "POST",
        headers: { "x-cove-session": sessionId },
      }),
    );
    const state2 = new URL((await startRes2.json()).url).searchParams.get("state");
    const denyRes = await handleRequest(
      new Request(`http://127.0.0.1:8971/api/netlify/oauth/callback?error=access_denied&state=${encodeURIComponent(state2)}`),
    );
    assert.equal(denyRes.status, 302);
    assert.equal(
      denyRes.headers.get("location"),
      "https://cove--cove-netlify-bot.netlify.live/?account=error&reason=access_denied",
    );

    // Valid callback
    const cbRes = await handleRequest(
      new Request(`http://127.0.0.1:8971/api/netlify/oauth/callback?code=auth_code_1&state=${encodeURIComponent(state)}`),
    );
    assert.equal(cbRes.status, 302);
    assert.equal(
      cbRes.headers.get("location"),
      "https://cove--cove-netlify-bot.netlify.live/?account=linked",
    );
    assert.match(lastTokenBody, /redirect_uri=https%3A%2F%2Fcove--cove-netlify-bot\.netlify\.live%2Fapi%2Fnetlify%2Foauth%2Fcallback/);

    // Verify status is now linked for that session
    const linkedStatus = await (
      await handleRequest(
        new Request("http://127.0.0.1:8971/api/netlify/status", {
          headers: { "x-cove-session": sessionId },
        }),
      )
    ).json();
    assert.equal(linkedStatus.linked, true);
    assert.equal(linkedStatus.method, "oauth");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("frontend scripts: valid JS syntax and key hardening invariants", () => {
  for (const file of ["app.js", "account.js", "providers.js", "conversations.js", "mascot.js"]) {
    const src = readFileSync(join(process.cwd(), "public", file), "utf8");
    assert.doesNotThrow(() => new vm.Script(src, { filename: file }), `${file} should parse cleanly`);
  }
  const providersSrc = readFileSync(join(process.cwd(), "public/providers.js"), "utf8");
  assert.match(providersSrc, /<div class="provider-card provider-card-cloud">/, "cloud provider cards must not nest forms inside <label>");
  assert.match(providersSrc, /OR_STATE/, "OpenRouter PKCE should verify random state");

  const mascotSrc = readFileSync(join(process.cwd(), "public/mascot.js"), "utf8");
  assert.match(mascotSrc, /if \(!rect\.width \|\| !rect\.height\) return/, "mascot parallax must guard against zero-size NaN");
});
