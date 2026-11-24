/**
 * Client for the Zoth Sovereign Agent Signal Bridge on 127.0.0.1:8102.
 *
 * This is how Cove asks the local mesh for a lease before running `agy`,
 * and how it posts handoff notes onto the shared agent bus. If the bridge
 * is unreachable, callers should fall back to the direct `agy` CLI. If the
 * bridge is up and denies the lease, do not bypass it.
 *
 * The Signal Messenger dispatcher (zoth-signal-bridge on :8768) is a
 * different service: it relays phone messages to agents. Cove does not
 * send or receive Signal messages.
 */
const DEFAULT_URL = "http://127.0.0.1:8102";

export function bridgeUrl() {
  return String(process.env.ZOTH_BRIDGE_URL || DEFAULT_URL).replace(/\/+$/, "");
}

function combineSignals(external, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  if (external) {
    if (external.aborted) ctrl.abort();
    else external.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    stop() {
      clearTimeout(timer);
      if (external) external.removeEventListener("abort", onAbort);
    },
  };
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

export async function probeBridge({ timeoutMs = 1500, signal, fetchImpl = fetch } = {}) {
  const url = bridgeUrl();
  const run = combineSignals(signal, timeoutMs);
  try {
    const res = await fetchImpl(`${url}/api/health`, { method: "GET", signal: run.signal });
    if (!res.ok) {
      return { ok: false, url, reason: `Sovereign Agent Bridge health returned ${res.status}.` };
    }
    const body = await readJson(res);
    return { ok: true, url, status: body.status || body.state || "ok" };
  } catch (err) {
    const timedOut = err?.name === "AbortError";
    return {
      ok: false,
      url,
      unreachable: true,
      reason: timedOut
        ? "Sovereign Agent Bridge did not respond in time."
        : `Sovereign Agent Bridge is unreachable (${err.message}).`,
    };
  } finally {
    run.stop();
  }
}

export async function authorizeTool({
  tool = "agy",
  pid = process.pid,
  workspace = "",
  argsText = "",
  timeoutMs = 2500,
  signal,
  fetchImpl = fetch,
} = {}) {
  const url = bridgeUrl();
  const run = combineSignals(signal, timeoutMs);
  const payload = {
    tool_name: tool,
    pid,
    workspace,
    args_text: String(argsText || "").slice(0, 240),
  };
  try {
    const res = await fetchImpl(`${url}/api/agents/authorize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: run.signal,
    });
    const body = await readJson(res);
    if (!res.ok || !body.authorized) {
      return {
        authorized: false,
        unreachable: false,
        status: res.status,
        leaseId: body.lease_id || body.leaseId || null,
        reason: body.reason || body.error || `Bridge denied ${tool} (${res.status}).`,
        raw: body,
      };
    }
    return {
      authorized: true,
      unreachable: false,
      status: res.status,
      leaseId: body.lease_id || body.leaseId,
      syncMd: body.sync_md || body.syncMd || null,
      raw: body,
    };
  } catch (err) {
    const timedOut = err?.name === "AbortError";
    return {
      authorized: false,
      unreachable: true,
      leaseId: null,
      reason: timedOut
        ? "Sovereign Agent Bridge did not respond in time."
        : `Sovereign Agent Bridge is unreachable (${err.message}).`,
    };
  } finally {
    run.stop();
  }
}

export async function releaseLease({
  leaseId,
  exitCode = 0,
  timeoutMs = 1500,
  signal,
  fetchImpl = fetch,
} = {}) {
  if (!leaseId) return { ok: false, skipped: true };
  const url = bridgeUrl();
  const run = combineSignals(signal, timeoutMs);
  try {
    const res = await fetchImpl(`${url}/api/agents/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lease_id: leaseId, exit_code: exitCode }),
      signal: run.signal,
    });
    const body = await readJson(res);
    return { ok: res.ok, status: res.status, raw: body };
  } catch (err) {
    return { ok: false, reason: err.message };
  } finally {
    run.stop();
  }
}

export async function postHandoff({
  sender = "cove",
  recipient = "agy",
  subject = "Cove handoff",
  body,
  workspace = "",
  channel = "zoth-bridge-bus",
  timeoutMs = 2500,
  signal,
  fetchImpl = fetch,
} = {}) {
  const text = String(body || "").trim();
  if (!text) return { ok: false, reason: "Message body is required." };
  const url = bridgeUrl();
  const run = combineSignals(signal, timeoutMs);
  try {
    const res = await fetchImpl(`${url}/api/agents/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sender,
        recipient,
        subject,
        body: text,
        channel,
        workspace,
      }),
      signal: run.signal,
    });
    const payload = await readJson(res);
    if (!res.ok) {
      return { ok: false, status: res.status, reason: payload.error || payload.reason || `handoff ${res.status}` };
    }
    return { ok: true, status: res.status, message: payload.message || payload };
  } catch (err) {
    return { ok: false, unreachable: true, reason: err.message };
  } finally {
    run.stop();
  }
}

export function leaseEnv(auth, baseEnv = process.env) {
  if (!auth?.authorized || !auth.leaseId) return { ...baseEnv };
  const env = { ...baseEnv };
  env.ZOTH_BRIDGE_AUTHORIZED = "1";
  env.ZOTH_BRIDGE_LEASE_ID = auth.leaseId;
  env.ZOTH_BRIDGE_URL = bridgeUrl();
  if (auth.syncMd) env.ZOTH_BRIDGE_SYNC_MD = auth.syncMd;
  return env;
}
