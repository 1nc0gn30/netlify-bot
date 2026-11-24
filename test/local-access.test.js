import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectLocalAccess,
  isLocalProviderId,
  LOCAL_PROVIDER_IDS,
} from "../netlify/server/lib/local-access.js";
import { handleRequest } from "../netlify/server/lib/app.js";
import coveFunction from "../netlify/functions/cove.js";

const LOCAL = "http://127.0.0.1:8971";
const LIVE_HOST = "cove--cove-netlify-bot.netlify.live";

function withEnv(value, fn) {
  const prev = process.env.COVE_LOCAL_AGENTS;
  if (value == null) delete process.env.COVE_LOCAL_AGENTS;
  else process.env.COVE_LOCAL_AGENTS = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev == null) delete process.env.COVE_LOCAL_AGENTS;
      else process.env.COVE_LOCAL_AGENTS = prev;
    });
}

function req(url, { method = "GET", headers = {}, body } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers["content-type"] = init.headers["content-type"] || "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request(url, init);
}

test("inspectLocalAccess: fail closed without opt-in, even on localhost", () => {
  return withEnv(undefined, () => {
    const access = inspectLocalAccess(req(`${LOCAL}/api/chat`));
    assert.equal(access.allowed, false);
    assert.equal(access.optedIn, false);
  });
});

test("inspectLocalAccess: opt-in plus localhost host and port is allowed", () => {
  return withEnv("1", () => {
    const access = inspectLocalAccess(req(`${LOCAL}/api/chat`, { headers: { host: "127.0.0.1:8971" } }));
    assert.equal(access.allowed, true, access.reasons.join(" "));
    const v6 = inspectLocalAccess(req("http://[::1]:8971/api/chat", { headers: { host: "[::1]:8971" } }));
    assert.equal(v6.allowed, true, v6.reasons.join(" "));
    const named = inspectLocalAccess(req("http://localhost:8971/api/chat", { headers: { host: "localhost:8971" } }));
    assert.equal(named.allowed, true, named.reasons.join(" "));
  });
});

test("inspectLocalAccess: netlify.live Host, forwarded headers, and public Origin are refused", () => {
  return withEnv("1", () => {
    const cases = [
      req(`${LOCAL}/api/chat`, { headers: { host: LIVE_HOST } }),
      req(`https://${LIVE_HOST}/api/chat`, { headers: { host: LIVE_HOST } }),
      req(`${LOCAL}/api/chat`, { headers: { host: "127.0.0.1:8971", "x-forwarded-for": "8.8.8.8" } }),
      req(`${LOCAL}/api/chat`, { headers: { host: "127.0.0.1:8971", "x-forwarded-host": LIVE_HOST } }),
      req(`${LOCAL}/api/chat`, { headers: { host: "127.0.0.1:8971", "x-nf-client-connection-ip": "1.2.3.4" } }),
      req(`${LOCAL}/api/chat`, { headers: { host: "127.0.0.1:8971", "x-nf-request-id": "abc", "x-forwarded-host": LIVE_HOST } }),
      req(`${LOCAL}/api/chat`, { headers: { host: "127.0.0.1:8971", origin: `https://${LIVE_HOST}` } }),
      req(`${LOCAL}/api/chat`, { headers: { host: "127.0.0.1:8971", referer: `https://${LIVE_HOST}/` } }),
      req(`${LOCAL}/api/chat`, { headers: { host: "example.com:8971" } }),
    ];
    for (const request of cases) {
      const access = inspectLocalAccess(request);
      assert.equal(access.allowed, false, `expected deny for ${request.headers.get("host")} ${[...request.headers.keys()].join(",")}`);
    }
  });
});

async function chat(provider, headers, session) {
  return handleRequest(req(`${LOCAL}/api/chat?stream=0`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "x-cove-session": session,
      host: "127.0.0.1:8971",
      ...headers,
    },
    body: { provider, messages: [{ role: "user", content: "Hello" }] },
  }));
}

test("inspectLocalAccess: local netlify dev metadata and loopback forwarding still allowed", () => {
  return withEnv("1", () => {
    const requestId = inspectLocalAccess(req(`${LOCAL}/api/chat`, {
      headers: { host: "127.0.0.1:8971", "x-nf-request-id": "01LOCALREQUESTID" },
    }));
    assert.equal(requestId.allowed, true, requestId.reasons.join(" "));
    const loopbackXff = inspectLocalAccess(req(`${LOCAL}/api/chat`, {
      headers: { host: "127.0.0.1:8971", "x-forwarded-for": "127.0.0.1" },
    }));
    assert.equal(loopbackXff.allowed, true, loopbackXff.reasons.join(" "));
  });
});

test("chat: every local provider is refused from a netlify.live Host, even with opt-in and loopback", async () => {
  await withEnv("1", async () => {
    for (const id of LOCAL_PROVIDER_IDS) {
      assert.equal(isLocalProviderId(id), true);
      const res = await chat(id, { host: LIVE_HOST }, `deny_live_${id}`);
      assert.equal(res.status, 403, id);
      const data = await res.json();
      assert.equal(data.code, "local-agents-forbidden");
      assert.match(data.error || "", /local agents/i);
    }
  });
});

test("chat: every local provider is refused when forwarded headers are present, even from loopback", async () => {
  await withEnv("1", async () => {
    for (const id of LOCAL_PROVIDER_IDS) {
      const res = await chat(id, { host: "127.0.0.1:8971", "x-forwarded-for": "203.0.113.10" }, `deny_xff_${id}`);
      assert.equal(res.status, 403, id);
      const data = await res.json();
      assert.equal(data.code, "local-agents-forbidden");
    }
  });
});

test("chat: local providers are refused when COVE_LOCAL_AGENTS is off, even on localhost", async () => {
  await withEnv(undefined, async () => {
    const res = await chat("agy", { host: "127.0.0.1:8971" }, "deny_env_off_agy");
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.code, "local-agents-forbidden");
  });
});

test("provider listing hides local agents and the signal bridge for tunneled or un-opted-in requests", async () => {
  await withEnv("1", async () => {
    const live = await handleRequest(req(`${LOCAL}/api/providers`, { headers: { host: LIVE_HOST } }));
    assert.equal(live.status, 200);
    const liveData = await live.json();
    assert.deepEqual(liveData.local, []);
    assert.equal(liveData.localAgents, false);
    assert.equal(liveData.signalBridge?.ok, false);
    assert.equal(liveData.signalBridge?.transport, "disabled");
    assert.ok(!(liveData.defaultId) || !LOCAL_PROVIDER_IDS.includes(liveData.defaultId));

    const forwarded = await handleRequest(req(`${LOCAL}/api/providers`, {
      headers: { host: "127.0.0.1:8971", "x-forwarded-for": "203.0.113.10" },
    }));
    const forwardedData = await forwarded.json();
    assert.deepEqual(forwardedData.local, []);
    assert.equal(forwardedData.localAgents, false);
  });

  await withEnv(undefined, async () => {
    const local = await handleRequest(req(`${LOCAL}/api/providers`, { headers: { host: "127.0.0.1:8971" } }));
    const data = await local.json();
    assert.deepEqual(data.local, []);
    assert.equal(data.localAgents, false);
  });
});

test("opted-in localhost requests can list local agents; research and knowledge refresh stay local-only", async () => {
  await withEnv("1", async () => {
    const catalogRes = await handleRequest(req(`${LOCAL}/api/providers`, { headers: { host: "127.0.0.1:8971" } }));
    assert.equal(catalogRes.status, 200);
    const catalog = await catalogRes.json();
    assert.equal(catalog.localAgents, true);
    assert.ok(Array.isArray(catalog.local));
    // agy is installed on this host; listing must be allowed to include it
    assert.ok(catalog.local.some((item) => item.id === "agy"), "expected agy in the local catalog for a genuine local request");
    assert.ok(["signal-bridge", "direct-cli-fallback"].includes(catalog.signalBridge?.transport));

    const liveResearch = await handleRequest(req(`${LOCAL}/api/research`, {
      method: "POST",
      headers: { host: LIVE_HOST, "x-cove-session": "deny_research_live" },
      body: {},
    }));
    assert.equal(liveResearch.status, 403);

    const liveRefresh = await handleRequest(req(`${LOCAL}/api/knowledge/refresh`, {
      method: "POST",
      headers: { host: LIVE_HOST, "x-cove-session": "deny_refresh_live" },
      body: {},
    }));
    assert.equal(liveRefresh.status, 403);
  });
});

test("Netlify Function path also refuses tunneled local-provider chat", async () => {
  await withEnv("1", async () => {
    const res = await coveFunction(req(`${LOCAL}/api/chat?stream=0`, {
      method: "POST",
      headers: {
        accept: "application/json",
        host: LIVE_HOST,
        "x-cove-session": "deny_fn_agy",
        "content-type": "application/json",
      },
      body: { provider: "agy", messages: [{ role: "user", content: "Hello" }] },
    }));
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.code, "local-agents-forbidden");
  });
});

test("echo provider still works on localhost without opt-in (it is not a host agent)", async () => {
  await withEnv(undefined, async () => {
    const res = await handleRequest(req(`${LOCAL}/api/chat?stream=0`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "x-cove-session": "echo_still_ok",
        host: "127.0.0.1:8971",
      },
      body: { provider: "echo", messages: [{ role: "user", content: "ping" }] },
    }));
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.provider, "echo");
    assert.match(data.text, /ping/);
  });
});
