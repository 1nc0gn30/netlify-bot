import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cacheDir, communityGuidePath, knowledgeDir } from "./paths.js";
import { LIMITS } from "./guards.js";

export const SOURCE_CATALOG = [
  { id: "netlify-ai", url: "https://netlify.ai", title: "Netlify setup for AI agents" },
  { id: "llms", url: "https://docs.netlify.com/llms.txt", title: "Netlify docs index for LLMs" },
  { id: "server", url: "https://docs.netlify.com/build/server.md", title: "Netlify Server overview" },
  { id: "server-get-started", url: "https://docs.netlify.com/build/server/get-started.md", title: "Get started with Netlify Server" },
  { id: "server-local", url: "https://docs.netlify.com/build/server/local-development.md", title: "Netlify Server local development" },
  { id: "functions", url: "https://docs.netlify.com/build/functions/overview.md", title: "Netlify Functions overview" },
  { id: "functions-get-started", url: "https://docs.netlify.com/build/functions/get-started.md", title: "Get started with Functions" },
  { id: "edge", url: "https://docs.netlify.com/build/edge-functions/overview.md", title: "Edge Functions overview" },
  { id: "blobs", url: "https://docs.netlify.com/build/data-and-storage/netlify-blobs.md", title: "Netlify Blobs" },
  { id: "forms", url: "https://docs.netlify.com/manage/forms/setup.md", title: "Netlify Forms setup" },
  { id: "redirects", url: "https://docs.netlify.com/manage/routing/redirects/overview.md", title: "Redirects" },
  { id: "cli", url: "https://docs.netlify.com/api-and-cli-guides/cli-guides/get-started-with-cli.md", title: "Get started with the CLI" },
  { id: "preview-servers", url: "https://docs.netlify.com/manage/preview-servers/overview.md", title: "Preview Servers" },
  { id: "dev-cli", url: "https://github.com/netlify/cli/blob/main/docs/commands/dev.md", title: "netlify dev command (CLI docs)" },
];

const UA = "Cove-Community-Netlify-Guide/0.1 (fan-made community helper; not affiliated with Netlify)";
const MAX_SOURCE_CHARS = 40_000;
let lastRefresh = null;
let refreshing = null;

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIMITS.fetchTimeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": UA,
        accept: "text/plain, text/markdown, text/html;q=0.8, */*;q=0.1",
      },
    });
    if (!res.ok) {
      return { ok: false, status: res.status, text: "" };
    }
    const text = (await res.text()).slice(0, MAX_SOURCE_CHARS);
    return { ok: true, status: res.status, text };
  } catch (err) {
    return { ok: false, status: 0, text: "", error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

function htmlToText(input, url) {
  const looksHtml = /<html/i.test(input) || /<body/i.test(input);
  if (!looksHtml) return input;
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function refreshOfficialSources({ reason = "manual" } = {}) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    await mkdir(cacheDir, { recursive: true });
    const results = [];
    for (const source of SOURCE_CATALOG) {
      const fetched = await fetchText(source.url);
      const body = fetched.ok ? htmlToText(fetched.text, source.url) : "";
      const record = {
        ...source,
        ok: fetched.ok && body.length > 40,
        status: fetched.status,
        error: fetched.error || (fetched.ok ? null : `HTTP ${fetched.status}`),
        fetchedAt: new Date().toISOString(),
        chars: body.length,
        reason,
      };
      if (record.ok) {
        await writeFile(join(cacheDir, `${source.id}.md`), `# ${source.title}\n\nSource: ${source.url}\nFetched: ${record.fetchedAt}\n\n${body}\n`);
      }
      results.push(record);
    }
    lastRefresh = {
      at: new Date().toISOString(),
      reason,
      sources: results,
      okCount: results.filter((r) => r.ok).length,
    };
    await writeFile(join(cacheDir, "index.json"), `${JSON.stringify(lastRefresh, null, 2)}\n`);
    return lastRefresh;
  })();
  try {
    return await refreshing;
  } finally {
    refreshing = null;
  }
}

export async function loadCachedSources() {
  if (!existsSync(join(cacheDir, "index.json"))) return { at: null, sources: [], okCount: 0 };
  try {
    const raw = JSON.parse(await readFile(join(cacheDir, "index.json"), "utf8"));
    lastRefresh = raw;
    return raw;
  } catch {
    return { at: null, sources: [], okCount: 0 };
  }
}

export async function ensureFresh({ reason = "startup", maxAgeMs = 6 * 60 * 60 * 1000 } = {}) {
  const current = lastRefresh || (await loadCachedSources());
  if (current?.at && Date.now() - Date.parse(current.at) < maxAgeMs) {
    return current;
  }
  return refreshOfficialSources({ reason });
}

export async function readCommunityGuide() {
  try {
    return await readFile(communityGuidePath, "utf8");
  } catch {
    return "";
  }
}

export async function writeCommunityGuide(markdown) {
  await mkdir(knowledgeDir, { recursive: true });
  await writeFile(communityGuidePath, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
}

export async function buildPromptKnowledge({ maxChars = 48_000 } = {}) {
  const chunks = [];
  const community = await readCommunityGuide();
  if (community.trim()) {
    chunks.push(`# Community-maintained guide (verified claims only)\n\n${community.trim()}`);
  }
  const index = lastRefresh || (await loadCachedSources());
  for (const source of SOURCE_CATALOG) {
    const file = join(cacheDir, `${source.id}.md`);
    if (!existsSync(file)) continue;
    try {
      const text = (await readFile(file, "utf8")).trim();
      if (text) chunks.push(text);
    } catch {
      // skip unreadable cache files
    }
  }
  let combined = chunks.join("\n\n---\n\n");
  if (combined.length > maxChars) {
    combined = `${combined.slice(0, maxChars)}\n\n[Knowledge truncated for length. Prefer the community guide and netlify.ai when unsure.]`;
  }
  return {
    text: combined,
    refreshedAt: index.at || null,
    sourceCount: index.okCount || 0,
  };
}

export function knowledgeStatus() {
  return lastRefresh;
}

export { knowledgeDir, communityGuidePath };
