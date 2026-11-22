/**
 * Link a visitor's Netlify account to this Cove session (read-only).
 *
 * Tokens live in memory for the Cove session only. They are never logged,
 * never written to disk, and `netlify login --check` is never run on the
 * host, so a visitor cannot overwrite the machine's CLI login.
 */
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { getSessionId, json, text } from "./guards.js";
import { projectRoot } from "./paths.js";

const STORE_PATH = path.join(projectRoot, "logs/cove-account-sessions.json");

const API = "https://api.netlify.com/api/v1";
const TOKEN_URL = "https://api.netlify.com/oauth/token";
const AUTHORIZE = "https://app.netlify.com/authorize";
// Public client id shipped with the official Netlify CLI (`netlify login --request`).
const CLI_CLIENT_ID =
  process.env.NETLIFY_CLI_OAUTH_CLIENT_ID ||
  "d6f37de6614df7ae58664cfca524744d73807a377f5ee71f1a254f78412e3750";

const SITE_TTL_MS = 2 * 60 * 1000;
const TICKET_TTL_MS = 10 * 60 * 1000;

let store = { links: {}, tickets: {}, oauthStates: {} };
let storeReady = false;

function pruneStore(now = Date.now()) {
  for (const [id, ticket] of Object.entries(store.tickets)) {
    if (!ticket?.createdAt || now - ticket.createdAt > TICKET_TTL_MS) delete store.tickets[id];
  }
  for (const [id, state] of Object.entries(store.oauthStates)) {
    if (!state?.createdAt || now - state.createdAt > TICKET_TTL_MS) delete store.oauthStates[id];
  }
}

async function loadStore() {
  if (storeReady) return store;
  try {
    store = JSON.parse(await readFile(STORE_PATH, "utf8"));
    if (!store.links || !store.tickets || !store.oauthStates) {
      store = { links: store.links || {}, tickets: store.tickets || {}, oauthStates: store.oauthStates || {} };
    }
  } catch {
    store = { links: {}, tickets: {}, oauthStates: {} };
  }
  pruneStore();
  storeReady = true;
  return store;
}

async function saveStore() {
  pruneStore();
  await mkdir(path.dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(store), { encoding: "utf8", mode: 0o600 });
  await rename(tmp, STORE_PATH);
  await chmod(STORE_PATH, 0o600);
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
  if (storeReady) return store;
  try {
    store = JSON.parse(readFileSync(STORE_PATH, "utf8"));
    if (!store.links || !store.tickets || !store.oauthStates) {
      store = { links: store.links || {}, tickets: store.tickets || {}, oauthStates: store.oauthStates || {} };
    }
  } catch {
    store = { links: {}, tickets: {}, oauthStates: {} };
  }
  pruneStore();
  storeReady = true;
  return store;
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
    return json({ ok: true, linked: false });
  }

  if (pathname === "/api/netlify/sites" && req.method === "GET") {
    const link = await refreshSites(sessionId, url.searchParams.get("refresh") === "1");
    if (!link) return json({ ok: false, error: "No Netlify account is linked in this session.", linked: false }, 401);
    return json({ ok: true, ...publicLink(link) });
  }

  if (pathname === "/api/netlify/cli/request" && req.method === "POST") {
    if (sessionId === "anon") return json({ error: "A Cove session is required." }, 400);
    const ticket = await netlifyFetch(`/oauth/tickets?client_id=${encodeURIComponent(CLI_CLIENT_ID)}`, {
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
    store.links[sessionId] = link; await saveStore();
    delete store.tickets[ticketId]; await saveStore();
    return json({ ok: true, status: "authorized", ...publicLink(link) });
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
      return json({ ok: true, ...publicLink(link) });
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
    const state = `${sessionId}.${crypto.randomUUID().replaceAll("-", "")}`;
    store.oauthStates[state] = { sessionId, createdAt: Date.now() }; await saveStore();
    const authorizeUrl = `${AUTHORIZE}?${new URLSearchParams({
      response_type: "code",
      client_id: process.env.NETLIFY_OAUTH_CLIENT_ID,
      redirect_uri: redirectUriFrom(req),
      state,
    }).toString()}`;
    return json({ ok: true, url: authorizeUrl });
  }

  if (pathname === "/api/netlify/oauth/callback" && req.method === "GET") {
    const origin = new URL(req.url).origin;
    const fail = (reason) => {
      const target = new URL("/", origin);
      target.searchParams.set("account", "error");
      target.searchParams.set("reason", reason);
      return new Response(null, { status: 302, headers: { location: target.toString(), "cache-control": "no-store" } });
    };
    if (!oauthConfigured()) return fail("oauth-not-configured");
    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    const meta = store.oauthStates[state];
    delete store.oauthStates[state]; await saveStore();
    if (!code || !meta || Date.now() - meta.createdAt > TICKET_TTL_MS) return fail("invalid-or-expired");
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: process.env.NETLIFY_OAUTH_CLIENT_ID,
      client_secret: process.env.NETLIFY_OAUTH_CLIENT_SECRET,
      redirect_uri: redirectUriFrom(req),
    });
    try {
      const tokenResponse = await netlifyFetch(TOKEN_URL, { method: "POST", form });
      const accessToken = tokenResponse?.access_token;
      if (!accessToken) return fail("no-token");
      const link = await hydrate(accessToken, "oauth");
      store.links[meta.sessionId] = link; await saveStore();
    } catch {
      return fail("exchange-failed");
    }
    const target = new URL("/", origin);
    target.searchParams.set("account", "linked");
    return new Response(null, { status: 302, headers: { location: target.toString(), "cache-control": "no-store" } });
  }

  return json({ error: "Not found" }, 404);
}
