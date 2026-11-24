/**
 * Link a visitor's Netlify account to this Cove session (read-only).
 *
 * Linked session tokens are stored locally on the host in a gitignored
 * 0600 JSON file (`logs/cove-account-sessions.json`, or `COVE_ACCOUNT_STORE_PATH`)
 * so linked sessions survive dev server / function reloads. Tokens are never
 * written to the browser, application logs, git, the shareable guide, or the
 * host CLI keychain (`netlify login --check` is never run on the host).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getSessionId, json, text } from "./guards.js";
import { projectRoot } from "./paths.js";

const DEFAULT_STORE_PATH = path.join(projectRoot, "logs/cove-account-sessions.json");
const TMP_STORE_PATH = path.join(os.tmpdir(), "cove-account-sessions.json");
let activeStorePath = process.env.COVE_ACCOUNT_STORE_PATH || DEFAULT_STORE_PATH;
const COOKIE_NAME = "cove_nf_link";
const EPHEMERAL_FALLBACK_KEY = randomBytes(32);

function cookieSecretMaterial() {
  const raw = process.env.COVE_SESSION_SECRET || process.env.NETLIFY_OAUTH_CLIENT_SECRET || "";
  if (raw) return createHash("sha256").update(`cove-nf-link:${raw}`).digest();
  return EPHEMERAL_FALLBACK_KEY;
}

function signState(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", cookieSecretMaterial()).update(`state:${body}`).digest("base64url");
  return `v1.${body}.${sig}`;
}

function verifySignedState(token) {
  if (typeof token !== "string" || !token.startsWith("v1.")) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [, body, sig] = parts;
  const expected = createHmac("sha256", cookieSecretMaterial()).update(`state:${body}`).digest();
  let provided;
  try {
    provided = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.sessionId || !parsed.createdAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

function sealLinkCookie(payload) {
  const key = cookieSecretMaterial();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

function unsealLinkCookie(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    const buf = Buffer.from(raw, "base64url");
    if (buf.length < 29) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", cookieSecretMaterial(), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(plain);
    if (!parsed?.token || !parsed?.sessionId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseCookieValue(req, name) {
  const header = req.headers.get("cookie") || "";
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return part.slice(idx + 1).trim();
  }
  return null;
}

function isHttpsRequest(req) {
  const proto = (req.headers.get("x-forwarded-proto") || "").split(",")[0].trim().toLowerCase();
  if (proto === "https") return true;
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

function buildLinkCookieHeader(req, payload) {
  const value = sealLinkCookie(payload);
  const attrs = [`${COOKIE_NAME}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=86400"];
  if (isHttpsRequest(req)) attrs.push("Secure");
  return attrs.join("; ");
}

function buildClearCookieHeader(req) {
  const attrs = [`${COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isHttpsRequest(req)) attrs.push("Secure");
  return attrs.join("; ");
}

function withCookie(response, cookieHeader) {
  if (!cookieHeader) return response;
  const headers = new Headers(response.headers);
  headers.append("set-cookie", cookieHeader);
  return new Response(response.body, { status: response.status, headers });
}

const API = "https://api.netlify.com/api/v1";
const TOKEN_URL = "https://api.netlify.com/oauth/token";
const AUTHORIZE = "https://app.netlify.com/authorize";

async function cliClientId() {
  if (process.env.NETLIFY_CLI_OAUTH_CLIENT_ID) return process.env.NETLIFY_CLI_OAUTH_CLIENT_ID;
  const candidates = [
    path.join(projectRoot, "node_modules/netlify-cli/dist/commands/base-command.js"),
    "/usr/local/lib/node_modules/netlify-cli/dist/commands/base-command.js",
    "/usr/lib/node_modules/netlify-cli/dist/commands/base-command.js",
  ];
  for (const candidate of candidates) {
    try {
      const mod = await import(pathToFileURL(candidate).href);
      if (mod.CLIENT_ID) return mod.CLIENT_ID;
    } catch {
      /* try the next install path */
    }
  }
  const err = new Error("Install the Netlify CLI or set NETLIFY_CLI_OAUTH_CLIENT_ID to use the login-ticket flow.");
  err.status = 501;
  throw err;
}

const SITE_TTL_MS = 2 * 60 * 1000;
const TICKET_TTL_MS = 10 * 60 * 1000;

let store = { links: {}, tickets: {}, oauthStates: {} };
let storeReady = false;
let storeStamp = null;

function emptyStore() {
  return { links: {}, tickets: {}, oauthStates: {} };
}

function normalizeStore(parsed) {
  if (!parsed || typeof parsed !== "object") return emptyStore();
  return {
    links: parsed.links && typeof parsed.links === "object" ? parsed.links : {},
    tickets: parsed.tickets && typeof parsed.tickets === "object" ? parsed.tickets : {},
    oauthStates: parsed.oauthStates && typeof parsed.oauthStates === "object" ? parsed.oauthStates : {},
  };
}

function fileStamp(info) {
  return info ? `${info.mtimeMs}:${info.size}` : null;
}

function pruneStore(now = Date.now()) {
  for (const [id, ticket] of Object.entries(store.tickets)) {
    if (!ticket?.createdAt || now - ticket.createdAt > TICKET_TTL_MS) delete store.tickets[id];
  }
  for (const [id, state] of Object.entries(store.oauthStates)) {
    if (!state?.createdAt || now - state.createdAt > TICKET_TTL_MS) delete store.oauthStates[id];
  }
}

async function loadStore() {
  let info = null;
  try {
    info = await stat(activeStorePath);
  } catch {
    info = null;
  }
  const stamp = fileStamp(info);
  if (storeReady && stamp === storeStamp) return store;
  if (!info) {
    store = emptyStore();
    storeStamp = null;
    storeReady = true;
    return store;
  }
  try {
    store = normalizeStore(JSON.parse(await readFile(activeStorePath, "utf8")));
  } catch {
    store = emptyStore();
  }
  pruneStore();
  storeStamp = stamp;
  storeReady = true;
  return store;
}

async function writeStoreTo(targetPath) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(store), { encoding: "utf8", mode: 0o600 });
  await rename(tmp, targetPath);
  await chmod(targetPath, 0o600);
  try {
    storeStamp = fileStamp(await stat(targetPath));
  } catch {
    storeStamp = null;
  }
}

async function saveStore() {
  pruneStore();
  try {
    await writeStoreTo(activeStorePath);
  } catch (err) {
    if ((err?.code === "EROFS" || err?.code === "EACCES" || err?.code === "EPERM") && activeStorePath !== TMP_STORE_PATH) {
      activeStorePath = TMP_STORE_PATH;
      try {
        await writeStoreTo(activeStorePath);
      } catch {
        /* serverless read-only fallback: rely on encrypted HttpOnly cookie */
      }
    }
  }
  storeReady = true;
}

function oauthConfigured() {
  return Boolean(process.env.NETLIFY_OAUTH_CLIENT_ID && process.env.NETLIFY_OAUTH_CLIENT_SECRET);
}

function requestOrigin(req) {
  if (process.env.COVE_PUBLIC_ORIGIN) return process.env.COVE_PUBLIC_ORIGIN.replace(/\/$/, "");
  const originHeader = req.headers.get("origin");
  if (originHeader && /^https?:\/\//i.test(originHeader)) return originHeader.replace(/\/$/, "");
  const forwarded = req.headers.get("forwarded");
  if (forwarded) {
    const host = forwarded.match(/host="?([^;,"]+)/i)?.[1];
    const proto = forwarded.match(/proto=([^;,"]+)/i)?.[1];
    if (host && proto) return `${proto}://${host}`;
  }
  const xfHost = (req.headers.get("x-forwarded-host") || "").split(",")[0].trim();
  const xfProto = (req.headers.get("x-forwarded-proto") || "").split(",")[0].trim();
  if (xfHost && xfProto) return `${xfProto}://${xfHost}`;
  const referer = req.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      /* ignore */
    }
  }
  const url = new URL(req.url);
  const host = (req.headers.get("host") || "").split(",")[0].trim();
  if (host && host !== url.host) {
    const proto = url.protocol.replace(":", "") === "https" || host.includes("netlify.live") ? "https" : url.protocol.replace(":", "");
    return `${proto}://${host}`;
  }
  return url.origin;
}

function redirectUriFrom(req) {
  if (process.env.NETLIFY_OAUTH_REDIRECT_URI) return process.env.NETLIFY_OAUTH_REDIRECT_URI;
  return `${requestOrigin(req)}/api/netlify/oauth/callback`;
}

async function netlifyFetch(path, { token, method = "GET", body, form, headers } = {}) {
  const url = path.startsWith("http") ? path : `${API}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...headers,
    },
    body: form ? form.toString() : body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error || data.error_description)) || `Netlify API ${res.status}`);
    err.status = res.status === 401 ? 401 : 502;
    throw err;
  }
  return data;
}

function sanitizeUser(user) {
  return {
    id: user?.id || null,
    name: user?.full_name || user?.name || null,
    email: user?.email || null,
  };
}

function sanitizeSite(site) {
  const deploy = site?.published_deploy || {};
  return {
    id: site.id,
    name: site.name,
    url: site.ssl_url || site.url || null,
    adminUrl: site.admin_url || null,
    accountName: site.account_name || site.account_slug || null,
    deploy: {
      state: deploy.state || null,
      context: deploy.context || null,
      publishedAt: deploy.published_at || deploy.created_at || null,
      branch: deploy.branch || null,
    },
  };
}

function publicLink(link) {
  if (!link?.user) return { linked: false, method: null, user: null, sites: [] };
  return { linked: true, method: link.method, user: link.user, sites: link.sites || [] };
}

async function hydrate(token, method) {
  const user = sanitizeUser(await netlifyFetch("/user", { token }));
  const sitesRaw = await netlifyFetch("/sites?per_page=20", { token });
  const sites = (Array.isArray(sitesRaw) ? sitesRaw : []).slice(0, 20).map(sanitizeSite);
  return { token, method, user, sites, sitesAt: Date.now(), linkedAt: Date.now() };
}

async function refreshSites(sessionId, force = false) {
  const link = store.links[sessionId];
  if (!link?.token) return null;
  if (!force && link.sitesAt && Date.now() - link.sitesAt < SITE_TTL_MS) return link;
  try {
    const next = await hydrate(link.token, link.method);
    store.links[sessionId] = next; await saveStore();
    return next;
  } catch (err) {
    if (err.status === 401) {
      delete store.links[sessionId]; await saveStore();
      return null;
    }
    return link;
  }
}

function loadStoreSync() {
  let info = null;
  try {
    info = statSync(activeStorePath);
  } catch {
    info = null;
  }
  const stamp = fileStamp(info);
  if (storeReady && stamp === storeStamp) return store;
  if (!info) {
    store = emptyStore();
    storeStamp = null;
    storeReady = true;
    return store;
  }
  try {
    store = normalizeStore(JSON.parse(readFileSync(activeStorePath, "utf8")));
  } catch {
    store = emptyStore();
  }
  pruneStore();
  storeStamp = stamp;
  storeReady = true;
  return store;
}

export async function ensureAccountLoaded(req, sessionId) {
  await loadStore();
  if (store.links[sessionId]?.token) return store.links[sessionId];
  const raw = parseCookieValue(req, COOKIE_NAME);
  if (!raw) return null;
  const sealed = unsealLinkCookie(raw);
  if (!sealed?.token) return null;
  if (sealed.sessionId && sessionId !== "anon" && sealed.sessionId !== sessionId) return null;
  try {
    const link = await hydrate(sealed.token, sealed.method || "oauth");
    store.links[sessionId] = link;
    await saveStore();
    return link;
  } catch {
    return null;
  }
}

export function accountContextText(sessionId) {
  loadStoreSync();
  const link = store.links[sessionId];
  if (!link?.user) return "";
  const who = [link.user.name, link.user.email].filter(Boolean).join(" · ") || "linked account";
  const lines = (link.sites || []).slice(0, 12).map((site) => {
    const state = site.deploy?.state ? `, last deploy ${site.deploy.state}` : "";
    const when = site.deploy?.publishedAt ? ` at ${site.deploy.publishedAt}` : "";
    const url = site.url ? ` (${site.url})` : "";
    return `- ${site.name}${url}${state}${when}`;
  });
  return `The visitor linked a Netlify account (read-only) as ${who}. Use this to answer questions about their sites and deploy status. Do not claim you can change, deploy, or delete anything. Do not reveal the access token; you do not have it.

Sites:
${lines.length ? lines.join("\n") : "- (no sites returned)"}`;
}

export async function handleNetlifyAccount(req) {
  const url = new URL(req.url);
  const { pathname } = url;
  if (!pathname.startsWith("/api/netlify")) return null;

  await loadStore();
  const sessionId = getSessionId(req);

  if (pathname === "/api/netlify/status" && req.method === "GET") {
    await ensureAccountLoaded(req, sessionId);
    await refreshSites(sessionId);
    return json({
      ok: true,
      oauthConfigured: oauthConfigured(),
      redirectUri: redirectUriFrom(req),
      cliClient: "official Netlify CLI public client",
      ...publicLink(store.links[sessionId]),
    });
  }

  if (pathname === "/api/netlify/disconnect" && req.method === "POST") {
    delete store.links[sessionId]; await saveStore();
    return withCookie(json({ ok: true, linked: false }), buildClearCookieHeader(req));
  }

  if (pathname === "/api/netlify/sites" && req.method === "GET") {
    await ensureAccountLoaded(req, sessionId);
    const link = await refreshSites(sessionId, url.searchParams.get("refresh") === "1");
    if (!link) return json({ ok: false, error: "No Netlify account is linked in this session.", linked: false }, 401);
    return json({ ok: true, ...publicLink(link) });
  }

  if (pathname === "/api/netlify/cli/request" && req.method === "POST") {
    if (sessionId === "anon") return json({ error: "A Cove session is required." }, 400);
    const clientId = await cliClientId();
    const ticket = await netlifyFetch(`/oauth/tickets?client_id=${encodeURIComponent(clientId)}`, {
      method: "POST",
      body: { message: "Cove, a fan-made community Netlify guide, is requesting read-only access to your sites and deploy status." },
    });
    if (!ticket?.id) return json({ error: "Netlify did not return a login ticket." }, 502);
    store.tickets[ticket.id] = { sessionId, createdAt: Date.now() }; await saveStore();
    const authorizeUrl = `${AUTHORIZE}?${new URLSearchParams({
      response_type: "ticket",
      ticket: ticket.id,
    }).toString()}`;
    return json({
      ok: true,
      ticketId: ticket.id,
      url: authorizeUrl,
      expiresInSec: TICKET_TTL_MS / 1000,
      cli: {
        request: `netlify login --request "Cove read-only site access" --json`,
        check: `netlify login --check ${ticket.id} --json`,
      },
      note: "Approve the URL in your browser. Cove will keep the token in this session only and will not store it in the host CLI keychain.",
    });
  }

  if (pathname === "/api/netlify/cli/check" && req.method === "GET") {
    const ticketId = url.searchParams.get("ticket") || "";
    const meta = store.tickets[ticketId];
    if (!ticketId || !meta || meta.sessionId !== sessionId) {
      return json({ status: "unknown", error: "That login ticket is not in this session." }, 400);
    }
    if (Date.now() - meta.createdAt > TICKET_TTL_MS) {
      delete store.tickets[ticketId]; await saveStore();
      return json({ status: "expired" });
    }
    let ticket;
    try {
      ticket = await netlifyFetch(`/oauth/tickets/${encodeURIComponent(ticketId)}`);
    } catch (err) {
      if (err.status === 401) return json({ status: "denied" });
      throw err;
    }
    if (!ticket?.authorized) return json({ status: "pending" });
    const tokenResponse = await netlifyFetch(`/oauth/tickets/${encodeURIComponent(ticketId)}/exchange`, { method: "POST" });
    const accessToken = tokenResponse?.access_token;
    if (!accessToken) return json({ error: "Netlify authorized the ticket but did not return a token." }, 502);
    const link = await hydrate(accessToken, "cli-ticket");
    store.links[sessionId] = link;
    delete store.tickets[ticketId];
    await saveStore();
    return withCookie(
      json({ ok: true, status: "authorized", ...publicLink(link) }),
      buildLinkCookieHeader(req, { token: accessToken, method: "cli-ticket", sessionId }),
    );
  }

  if (pathname === "/api/netlify/token" && req.method === "POST") {
    if (sessionId === "anon") return json({ error: "A Cove session is required." }, 400);
    const payload = await req.json().catch(() => null);
    const token = String(payload?.token || "").trim();
    if (!token || token.length < 20 || token.length > 300) {
      return json({ error: "That does not look like a Netlify personal access token." }, 400);
    }
    try {
      const link = await hydrate(token, "personal-token");
      store.links[sessionId] = link; await saveStore();
      return withCookie(
        json({ ok: true, ...publicLink(link) }),
        buildLinkCookieHeader(req, { token, method: "personal-token", sessionId }),
      );
    } catch (err) {
      return json({ error: "Netlify rejected that token. Create a personal access token at app.netlify.com → User settings → Applications." }, 401);
    }
  }

  if (pathname === "/api/netlify/oauth/start" && req.method === "POST") {
    if (!oauthConfigured()) {
      return json({
        ok: false,
        error: "Web OAuth is not configured on this host.",
        redirectUri: redirectUriFrom(req),
        hint: "Register a Netlify OAuth application at app.netlify.com → User settings → Applications, then set NETLIFY_OAUTH_CLIENT_ID and NETLIFY_OAUTH_CLIENT_SECRET. Use the redirect URI returned here.",
      }, 501);
    }
    if (sessionId === "anon") return json({ error: "A Cove session is required." }, 400);
    const redirectUri = redirectUriFrom(req);
    const createdAt = Date.now();
    const state = signState({ sessionId, redirectUri, createdAt, nonce: crypto.randomUUID().replaceAll("-", "") });
    store.oauthStates[state] = { sessionId, redirectUri, createdAt }; await saveStore();
    const authorizeUrl = `${AUTHORIZE}?${new URLSearchParams({
      response_type: "code",
      client_id: process.env.NETLIFY_OAUTH_CLIENT_ID,
      redirect_uri: redirectUri,
      state,
    }).toString()}`;
    return json({ ok: true, url: authorizeUrl });
  }

  if (pathname === "/api/netlify/oauth/callback" && req.method === "GET") {
    const state = url.searchParams.get("state") || "";
    const meta = store.oauthStates[state] || verifySignedState(state);
    const effectiveRedirectUri = meta?.redirectUri || redirectUriFrom(req);
    const origin = new URL(effectiveRedirectUri).origin;
    const fail = (reason) => {
      const target = new URL("/", origin);
      target.searchParams.set("account", "error");
      target.searchParams.set("reason", reason);
      return new Response(null, { status: 302, headers: { location: target.toString(), "cache-control": "no-store" } });
    };
    if (!oauthConfigured()) return fail("oauth-not-configured");
    if (store.oauthStates[state]) {
      delete store.oauthStates[state];
      await saveStore();
    }
    const oauthError = url.searchParams.get("error");
    if (oauthError) {
      const safeReason = oauthError.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || "oauth-denied";
      return fail(safeReason);
    }
    const code = url.searchParams.get("code") || "";
    if (!code || !meta || Date.now() - meta.createdAt > TICKET_TTL_MS) return fail("invalid-or-expired");
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: process.env.NETLIFY_OAUTH_CLIENT_ID,
      client_secret: process.env.NETLIFY_OAUTH_CLIENT_SECRET,
      redirect_uri: effectiveRedirectUri,
    });
    let accessToken = "";
    try {
      const tokenResponse = await netlifyFetch(TOKEN_URL, { method: "POST", form });
      accessToken = tokenResponse?.access_token || "";
      if (!accessToken) return fail("no-token");
      const link = await hydrate(accessToken, "oauth");
      store.links[meta.sessionId] = link; await saveStore();
    } catch {
      return fail("exchange-failed");
    }
    const target = new URL("/", origin);
    target.searchParams.set("account", "linked");
    return new Response(null, {
      status: 302,
      headers: {
        location: target.toString(),
        "cache-control": "no-store",
        "set-cookie": buildLinkCookieHeader(req, { token: accessToken, method: "oauth", sessionId: meta.sessionId }),
      },
    });
  }

  return json({ error: "Not found" }, 404);
}
