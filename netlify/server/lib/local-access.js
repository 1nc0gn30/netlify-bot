/**
 * Fail-closed gate for laptop-local agents (agy, Hermes Agent, Muse, Grok CLI,
 * and the Sovereign Agent Signal Bridge path).
 *
 * Loopback IP is not enough: a `netlify dev --live` tunnel also arrives from
 * ::1. Local agents run only when all of the following are true:
 *   - COVE_LOCAL_AGENTS=1 on the server process (off by default; never set in
 *     netlify.toml or a production deploy)
 *   - Host is localhost / 127.0.0.1 / [::1] with the expected dev port
 *   - Origin and Referer, if present, are localhost on that same port
 *   - the Host / Origin / Referer is not a *.netlify.live or *.netlify.app URL
 *   - x-forwarded-host, if present, is localhost; x-forwarded-for / x-real-ip /
 *     x-nf-client-connection-ip, if present, are only loopback addresses
 *
 * Local `netlify dev` adds x-nf-request-id (and sometimes loopback
 * forwarding). Those metadata headers are not enough to allow a request.
 * A public tunnel is still refused by Host, Origin, x-forwarded-host, and
 * any non-loopback forwarding address.
 *
 * The UI may hide local providers; this module is the actual guard.
 */
export const LOCAL_PROVIDER_IDS = Object.freeze(["agy", "hermes", "muse", "grok"]);

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const FORWARDED_HEADER = /^(x-forwarded-.*|x-real-ip|x-nf-.*|forwarded)$/i;

const PUBLIC_NETLIFY = /(?:^|\.)netlify\.(live|app)(?::\d+)?$/i;

export function localAgentsOptedIn() {
  const raw = String(process.env.COVE_LOCAL_AGENTS || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function expectedLocalPort() {
  const port = String(process.env.PORT || process.env.COVE_PORT || "8971").trim();
  return port || "8971";
}

export function isLocalProviderId(id) {
  return LOCAL_PROVIDER_IDS.includes(String(id || "").toLowerCase());
}

export function splitHostPort(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return { hostname: "", port: "" };
  if (raw.startsWith("[")) {
    const match = raw.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (match) return { hostname: match[1], port: match[2] || "" };
  }
  // hostname:port, but not IPv6 without brackets
  const colon = raw.lastIndexOf(":");
  if (colon > -1 && raw.indexOf(":") === colon) {
    return { hostname: raw.slice(0, colon), port: raw.slice(colon + 1) };
  }
  return { hostname: raw, port: "" };
}

function isLocalHostname(hostname) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  return LOCAL_HOSTS.has(host);
}

export function isPublicNetlifyHost(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return false;
  try {
    if (/^https?:\/\//i.test(raw)) {
      return PUBLIC_NETLIFY.test(new URL(raw).hostname);
    }
  } catch {
    /* fall through */
  }
  const { hostname } = splitHostPort(raw);
  return PUBLIC_NETLIFY.test(hostname) || PUBLIC_NETLIFY.test(raw);
}

function originOrRefererIsLocal(value, expectedPort) {
  const raw = String(value || "").trim();
  if (!raw) return true;
  if (isPublicNetlifyHost(raw)) return false;
  try {
    const url = new URL(raw);
    if (!/^https?:$/i.test(url.protocol)) return false;
    if (!isLocalHostname(url.hostname)) return false;
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return port === String(expectedPort);
  } catch {
    return false;
  }
}

function headerEntries(req) {
  const headers = req?.headers;
  if (!headers) return [];
  if (typeof headers.entries === "function") return [...headers.entries()];
  return Object.entries(headers);
}

function headerValue(req, name) {
  const headers = req?.headers;
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || "";
  const direct = headers[name] || headers[name.toLowerCase()];
  return direct == null ? "" : String(direct);
}


function isLoopbackAddress(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!raw) return false;
  if (LOCAL_HOSTS.has(raw)) return true;
  if (raw === "::ffff:127.0.0.1") return true;
  return raw.startsWith("::ffff:127.0.0.1:");
}

function forwardedAddresses(value) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function headerLooksPublicNetlify(value) {
  const raw = String(value || "");
  return /\.netlify\.(live|app)(?::\d+)?/i.test(raw) || isPublicNetlifyHost(raw);
}

// Local `netlify dev` adds function metadata such as x-nf-request-id.
// The public live tunnel is still rejected via Host, Origin/Referer,
// x-forwarded-host, and any non-loopback forwarding address.
const EDGE_CLIENT_HEADER = /^(x-forwarded-for|x-forwarded-host|x-real-ip|x-nf-client-connection-ip|x-nf-client-ip|x-nf-geo|forwarded)$/i;

export function inspectLocalAccess(req) {
  const reasons = [];
  const expectedPort = expectedLocalPort();
  if (!localAgentsOptedIn()) {
    reasons.push("COVE_LOCAL_AGENTS is not enabled on the server.");
  }

  const hostRaw = headerValue(req, "host") || "";
  // Fetch Request often has the port only in the URL when Host was omitted.
  let hostSource = hostRaw;
  if (!hostSource) {
    try {
      hostSource = new URL(req.url).host;
    } catch {
      hostSource = "";
    }
  }
  const { hostname, port } = splitHostPort(hostSource);
  const hostPort = port || "";
  if (!isLocalHostname(hostname)) {
    reasons.push("Host is not localhost, 127.0.0.1, or [::1].");
  }
  if (hostPort !== expectedPort) {
    reasons.push(`Host port must be ${expectedPort}.`);
  }
  if (isPublicNetlifyHost(hostSource) || isPublicNetlifyHost(hostname)) {
    reasons.push("Host is a public Netlify URL.");
  }

  for (const [name, value] of headerEntries(req)) {
    if (!value) continue;
    const lower = name.toLowerCase();
    if (headerLooksPublicNetlify(value)) {
      reasons.push(`Header ${lower} points at a public Netlify URL.`);
      continue;
    }
    if (lower === "x-forwarded-host") {
      const forwarded = splitHostPort(value);
      if (!isLocalHostname(forwarded.hostname) || (forwarded.port && forwarded.port !== expectedPort)) {
        reasons.push("x-forwarded-host is not localhost with the expected port.");
      }
      continue;
    }
    if (lower === "x-forwarded-for" || lower === "x-real-ip" || lower === "x-nf-client-connection-ip" || lower === "x-nf-client-ip") {
      const ips = forwardedAddresses(value);
      if (!ips.length || ips.some((ip) => !isLoopbackAddress(ip))) {
        reasons.push(`${lower} contains a non-loopback address.`);
      }
      continue;
    }
    if (lower === "forwarded") {
      const forParts = [...String(value).matchAll(/for=([^;\s,]+)/gi)].map((m) => m[1].replace(/^"|"$/g, ""));
      if (forParts.some((part) => !isLoopbackAddress(part))) {
        reasons.push("forwarded header contains a non-loopback address.");
      }
      continue;
    }
    // Other x-nf-* metadata (request id, invocation id, geo placeholders)
    // is added by local `netlify dev` and is not by itself evidence of a
    // public tunnel. Public tunnels are rejected via Host, Origin/Referer,
    // x-forwarded-host, and non-loopback forwarding addresses.
  }

  const origin = headerValue(req, "origin");
  const referer = headerValue(req, "referer") || headerValue(req, "referrer");
  if (origin && !originOrRefererIsLocal(origin, expectedPort)) {
    reasons.push("Origin is not a localhost URL.");
  }
  if (referer && !originOrRefererIsLocal(referer, expectedPort)) {
    reasons.push("Referer is not a localhost URL.");
  }

  return {
    allowed: reasons.length === 0,
    optedIn: localAgentsOptedIn(),
    expectedPort,
    reasons,
  };
}

export function isLocalAgentRequest(req) {
  return inspectLocalAccess(req).allowed;
}

export function localAgentsForbiddenPayload(access) {
  const reasons = access?.reasons?.length ? ` ${access.reasons.join(" ")}` : "";
  return {
    error: `Local agents are only available when Cove is used on this machine.${reasons}`,
    hint: "Use an API key you paste in this tab, or sign in with OpenRouter. Cove will not run agy, Hermes Agent, Muse, Grok CLI, or the Signal Bridge on this laptop for a public or tunneled request.",
    code: "local-agents-forbidden",
  };
}

export function localAgentsForbiddenError(access) {
  const payload = localAgentsForbiddenPayload(access);
  const err = new Error(payload.error);
  err.status = 403;
  err.payload = payload;
  return err;
}

export function assertLocalAgentRequest(req) {
  const access = inspectLocalAccess(req);
  if (!access.allowed) throw localAgentsForbiddenError(access);
  return access;
}
