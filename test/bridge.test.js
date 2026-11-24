import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  authorizeTool,
  bridgeUrl,
  leaseEnv,
  postHandoff,
  probeBridge,
  releaseLease,
} from "../netlify/server/lib/signal-bridge.js";
import { AgyProvider } from "../netlify/server/lib/agy.js";

function listen(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": buf.byteLength,
  });
  res.end(buf);
}

async function withBridge(handler, fn) {
  const prev = process.env.ZOTH_BRIDGE_URL;
  const { server, url } = await listen(handler);
  process.env.ZOTH_BRIDGE_URL = url;
  try {
    return await fn({ url, server });
  } finally {
    if (prev == null) delete process.env.ZOTH_BRIDGE_URL;
    else process.env.ZOTH_BRIDGE_URL = prev;
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test("bridgeUrl uses ZOTH_BRIDGE_URL without a trailing slash", () => {
  const prev = process.env.ZOTH_BRIDGE_URL;
  process.env.ZOTH_BRIDGE_URL = "http://127.0.0.1:8102/";
  try {
    assert.equal(bridgeUrl(), "http://127.0.0.1:8102");
  } finally {
    if (prev == null) delete process.env.ZOTH_BRIDGE_URL;
    else process.env.ZOTH_BRIDGE_URL = prev;
  }
});

test("probeBridge: healthy mesh returns ok", async () => {
  await withBridge((req, res) => {
    assert.equal(req.url, "/api/health");
    json(res, 200, { status: "ok" });
  }, async () => {
    const result = await probeBridge();
    assert.equal(result.ok, true);
    assert.equal(result.status, "ok");
    assert.match(result.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

test("probeBridge: down server is unreachable fallback", async () => {
  const prev = process.env.ZOTH_BRIDGE_URL;
  process.env.ZOTH_BRIDGE_URL = "http://127.0.0.1:1";
  try {
    const result = await probeBridge({ timeoutMs: 400 });
    assert.equal(result.ok, false);
    assert.equal(result.unreachable, true);
    assert.match(result.reason, /unreachable|did not respond/i);
  } finally {
    if (prev == null) delete process.env.ZOTH_BRIDGE_URL;
    else process.env.ZOTH_BRIDGE_URL = prev;
  }
});

test("authorizeTool: grant returns lease; 403 is a hard deny; down is unreachable", async () => {
  const calls = [];
  await withBridge((req, res) => {
    calls.push({ method: req.method, url: req.url });
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (body.tool_name === "locked") {
        json(res, 403, { authorized: false, reason: "LOCKED", lease_id: "lease-denied" });
        return;
      }
      assert.equal(body.tool_name, "agy");
      assert.equal(typeof body.pid, "number");
      assert.ok(String(body.args_text).includes("--print"));
      assert.ok(body.args_text.length <= 240);
      json(res, 200, { authorized: true, lease_id: "lease-agy-test", sync_md: "/tmp/AGENT_BRIDGE_SYNC.md" });
    });
  }, async () => {
    const ok = await authorizeTool({
      tool: "agy",
      pid: 42,
      workspace: "/tmp/cove-agy-test",
      argsText: "--print --sandbox --disable-slash-commands --output-format stream-json",
    });
    assert.equal(ok.authorized, true);
    assert.equal(ok.leaseId, "lease-agy-test");
    assert.equal(ok.unreachable, false);
    const env = leaseEnv(ok, { PATH: "/usr/bin" });
    assert.equal(env.ZOTH_BRIDGE_AUTHORIZED, "1");
    assert.equal(env.ZOTH_BRIDGE_LEASE_ID, "lease-agy-test");
    assert.equal(env.ZOTH_BRIDGE_SYNC_MD, "/tmp/AGENT_BRIDGE_SYNC.md");
    assert.equal(env.PATH, "/usr/bin");

    const denied = await authorizeTool({ tool: "locked" });
    assert.equal(denied.authorized, false);
    assert.equal(denied.unreachable, false);
    assert.match(denied.reason, /LOCKED/);
  });
  assert.deepEqual(calls.map((c) => c.url), ["/api/agents/authorize", "/api/agents/authorize"]);

  const prev = process.env.ZOTH_BRIDGE_URL;
  process.env.ZOTH_BRIDGE_URL = "http://127.0.0.1:1";
  try {
    const down = await authorizeTool({ tool: "agy", timeoutMs: 400 });
    assert.equal(down.authorized, false);
    assert.equal(down.unreachable, true);
  } finally {
    if (prev == null) delete process.env.ZOTH_BRIDGE_URL;
    else process.env.ZOTH_BRIDGE_URL = prev;
  }
});

test("releaseLease and postHandoff hit the bridge routes", async () => {
  const posts = [];
  await withBridge((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      posts.push({ url: req.url, body });
      if (req.url === "/api/agents/release") {
        json(res, 200, { ok: true, lease_id: body.lease_id });
        return;
      }
      if (req.url === "/api/agents/message") {
        json(res, 200, { status: "ok", message: { id: "msg-1", ...body } });
        return;
      }
      json(res, 404, { error: "nope" });
    });
  }, async () => {
    const released = await releaseLease({ leaseId: "lease-agy-test", exitCode: 0 });
    assert.equal(released.ok, true);
    const skipped = await releaseLease({ leaseId: null });
    assert.equal(skipped.skipped, true);
    const note = await postHandoff({
      sender: "cove",
      recipient: "agy",
      subject: "test",
      body: "hello from unit test",
      workspace: "/tmp",
    });
    assert.equal(note.ok, true);
    assert.equal(note.message.id, "msg-1");
  });
  assert.equal(posts[0].url, "/api/agents/release");
  assert.equal(posts[0].body.lease_id, "lease-agy-test");
  assert.equal(posts[1].url, "/api/agents/message");
  assert.equal(posts[1].body.body, "hello from unit test");
  assert.equal(posts[1].body.recipient, "agy");
});

test("AgyProvider: hard lease denial throws clear 403 ProviderError without spawning agy", async () => {
  await withBridge((req, res) => {
    if (req.url === "/api/health") {
      json(res, 200, { status: "ok" });
      return;
    }
    if (req.url === "/api/agents/authorize") {
      json(res, 403, { authorized: false, reason: "LOCKED" });
      return;
    }
    json(res, 404, { error: "not found" });
  }, async () => {
    const provider = new AgyProvider();
    assert.equal(provider.kind, "local-cli");
    await assert.rejects(
      async () => {
        for await (const _ of provider.stream({ systemPrompt: "hello" })) {
          /* should not yield */
        }
      },
      (err) => {
        assert.equal(err.status, 403);
        assert.match(err.message, /Sovereign Agent Bridge denied the agy execution lease/i);
        assert.match(err.message, /LOCKED/);
        assert.match(err.message, /will not bypass/i);
        return true;
      },
    );
  });
});
