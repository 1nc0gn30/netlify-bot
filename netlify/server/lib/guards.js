const sessions = new Map();

export const LIMITS = {
  maxInputChars: 6000,
  maxMessages: 24,
  maxMessageChars: 8000,
  windowMs: 10 * 60 * 1000,
  maxRequestsPerWindow: 8,
  maxConcurrent: 2,
  chatTimeoutMs: 180_000,
  researchTimeoutMs: 240_000,
  fetchTimeoutMs: 20_000,
};

let inFlight = 0;

function bucket(sessionId) {
  const id = String(sessionId || "anon").slice(0, 80);
  const now = Date.now();
  let entry = sessions.get(id);
  if (!entry || now - entry.start > LIMITS.windowMs) {
    entry = { start: now, count: 0 };
    sessions.set(id, entry);
  }
  return entry;
}

export function getSessionId(req) {
  const header = req.headers.get("x-cove-session") || "";
  if (/^[a-zA-Z0-9_-]{8,80}$/.test(header)) return header;
  return "anon";
}

export function assertRateLimit(sessionId) {
  const entry = bucket(sessionId);
  if (entry.count >= LIMITS.maxRequestsPerWindow) {
    const err = new Error("This session has reached the rate limit. Try again in a few minutes.");
    err.status = 429;
    throw err;
  }
  entry.count += 1;
}

export function assertInput(payload) {
  if (!payload || typeof payload !== "object") {
    const err = new Error("Expected a JSON body.");
    err.status = 400;
    throw err;
  }
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  if (messages.length === 0) {
    const err = new Error("Please include at least one message.");
    err.status = 400;
    throw err;
  }
  if (messages.length > LIMITS.maxMessages) {
    const err = new Error(`Please keep the conversation under ${LIMITS.maxMessages} messages.`);
    err.status = 400;
    throw err;
  }
  const clean = [];
  let total = 0;
  for (const msg of messages) {
    const role = msg?.role === "assistant" ? "assistant" : "user";
    const content = String(msg?.content || "").replace(/\u0000/g, "").trim();
    if (!content) continue;
    if (content.length > LIMITS.maxMessageChars) {
      const err = new Error(`Each message must be under ${LIMITS.maxMessageChars} characters.`);
      err.status = 400;
      throw err;
    }
    total += content.length;
    clean.push({ role, content });
  }
  if (clean.length === 0) {
    const err = new Error("Message was empty.");
    err.status = 400;
    throw err;
  }
  if (total > LIMITS.maxInputChars) {
    const err = new Error(`Please keep your question under ${LIMITS.maxInputChars} characters.`);
    err.status = 400;
    throw err;
  }
  const last = clean[clean.length - 1];
  if (last.role !== "user") {
    const err = new Error("The last message should come from you.");
    err.status = 400;
    throw err;
  }
  return clean;
}

export async function withConcurrency(fn) {
  if (inFlight >= LIMITS.maxConcurrent) {
    const err = new Error("Cove is already answering a couple of questions. Try again in a moment.");
    err.status = 429;
    throw err;
  }
  inFlight += 1;
  try {
    return await fn();
  } finally {
    inFlight -= 1;
  }
}

export function bufferResponse(body, status = 200, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""), "utf8");
  const h = new Headers(headers);
  h.delete("connection");
  h.delete("keep-alive");
  h.delete("transfer-encoding");
  h.set("content-length", String(buf.byteLength));
  return new Response(buf, { status, headers: h });
}

export function json(data, status = 200, extra = {}) {
  return bufferResponse(JSON.stringify(data, null, 2), status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extra,
  });
}

export function text(body, status = 200, type = "text/plain; charset=utf-8") {
  return bufferResponse(body, status, {
    "content-type": type,
    "cache-control": "no-store",
  });
}
