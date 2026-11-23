import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

function collectJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(full, out);
    } else if (/\.(m?js|cjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function checkSyntax(filePath) {
  execFileSync(process.execPath, ["--check", filePath], { stdio: "pipe" });
}

test("syntax: all JS files in public/ and netlify/ pass node --check", () => {
  const files = [
    ...collectJsFiles(join(ROOT, "public")),
    ...collectJsFiles(join(ROOT, "netlify")),
  ];
  assert.ok(files.length >= 10, "expected frontend and server JS files");
  for (const file of files) {
    assert.doesNotThrow(() => checkSyntax(file), `syntax error in ${file}`);
  }
});

test("security: no leaked secrets or tokens in git-tracked files", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const secretPatterns = [
    { name: "Anthropic key", re: /sk-ant-api03-[A-Za-z0-9_-]{20,}/ },
    { name: "OpenAI key", re: /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/ },
    { name: "OpenRouter key", re: /sk-or-v1-[a-f0-9]{32,}/i },
    { name: "GitHub PAT", re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
    { name: "Google API key", re: /AIza[0-9A-Za-z_-]{35}/ },
    { name: "Private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
    { name: "Netlify PAT", re: /\bnfp_[A-Za-z0-9]{24,}\b/ },
  ];

  const textExt = /\.(js|mjs|cjs|ts|json|md|html|css|toml|txt|xml|svg|yml|yaml)$/i;
  for (const rel of tracked) {
    if (!textExt.test(rel)) continue;
    if (rel.startsWith("test/") || rel.startsWith("tests/")) continue;
    const content = read(rel);
    for (const { name, re } of secretPatterns) {
      assert.doesNotMatch(content, re, `possible ${name} leaked in tracked file ${rel}`);
    }
  }
});

test("providers: server provider config modules export valid catalogs and factories", async () => {
  const cloudMod = await import(pathToFileURL(join(ROOT, "netlify/server/lib/cloud-providers.js")).href);
  const providersMod = await import(pathToFileURL(join(ROOT, "netlify/server/lib/providers.js")).href);
  const localClisMod = await import(pathToFileURL(join(ROOT, "netlify/server/lib/local-clis.js")).href);

  assert.ok(Array.isArray(cloudMod.CLOUD_CATALOG) && cloudMod.CLOUD_CATALOG.length >= 4, "CLOUD_CATALOG must list cloud providers");
  for (const entry of cloudMod.CLOUD_CATALOG) {
    assert.ok(entry.id && typeof entry.id === "string", "provider entry missing id");
    assert.ok(entry.label && typeof entry.label === "string", `provider ${entry.id} missing label`);
    const p = cloudMod.createCloudProvider(entry);
    assert.equal(p.id, entry.id);
    assert.equal(typeof p.stream, "function");
  }
  assert.equal(typeof providersMod.registerProvider, "function");
  assert.equal(typeof providersMod.getProvider, "function");
  assert.ok(localClisMod && typeof localClisMod === "object");

  const publicProviders = read("public/providers.js");
  assert.match(publicProviders, /window\.CoveProviders\s*=/);
  assert.match(publicProviders, /sessionStorage/);
});

test("guardrail: public/robots.txt allows all 6 frontier bots with Crawl-delay: 0 and Sitemap", () => {
  const robots = read("public/robots.txt");
  for (const bot of ["*", "Googlebot", "GPTBot", "ClaudeBot", "PerplexityBot", "Applebot"]) {
    assert.match(robots, new RegExp(`User-agent:\\s*${bot === "*" ? "\\*" : bot}`), `missing ${bot}`);
  }
  assert.match(robots, /Crawl-delay:\s*0/i);
  assert.match(robots, /Sitemap:\s*https:\/\/[^\s]+\/sitemap\.xml/i);
});

test("guardrail: public/sitemap.xml is well-formed with canonical HTTPS URL and lastmod", () => {
  const sitemap = read("public/sitemap.xml");
  assert.match(sitemap, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(sitemap, /<urlset\s+xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.match(sitemap, /<loc>https:\/\/[^<]+<\/loc>/);
  assert.match(sitemap, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
  assert.match(sitemap, /<\/urlset>/);
});

test("guardrail: netlify.toml defines publish dir, security headers, and SPA redirect", () => {
  const toml = read("netlify.toml");
  assert.match(toml, /publish\s*=\s*"public"/);
  assert.match(toml, /X-Frame-Options\s*=\s*"SAMEORIGIN"/);
  assert.match(toml, /X-Content-Type-Options\s*=\s*"nosniff"/);
  assert.match(toml, /Referrer-Policy\s*=\s*"strict-origin-when-cross-origin"/);
  assert.match(toml, /\[\[redirects\]\]/);
  assert.match(toml, /from\s*=\s*"\/\*"/);
  assert.match(toml, /to\s*=\s*"\/index\.html"/);
  assert.match(toml, /status\s*=\s*200/);
});

test("guardrail: public/index.html has valid JSON-LD @graph with WebApplication and FAQPage", () => {
  const html = read("public/index.html");
  const match = html.match(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/i);
  assert.ok(match, "missing JSON-LD script block");
  const data = JSON.parse(match[1]);
  assert.equal(data["@context"], "https://schema.org");
  assert.ok(Array.isArray(data["@graph"]), "@graph must be an array");

  const types = data["@graph"].flatMap((node) =>
    Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]]
  );
  assert.ok(
    types.includes("WebApplication") || types.includes("SoftwareApplication"),
    "JSON-LD @graph must include WebApplication or SoftwareApplication"
  );
  assert.ok(types.includes("FAQPage"), "JSON-LD @graph must include FAQPage");

  const faq = data["@graph"].find((n) => n["@type"] === "FAQPage");
  assert.ok(Array.isArray(faq.mainEntity) && faq.mainEntity.length >= 2, "FAQPage needs >= 2 questions");
});

test("guardrail: public/index.html has viewport, OpenGraph, Twitter Card, Stripe Coffee, Solana tip, and zero paywalls", () => {
  const html = read("public/index.html");
  assert.match(html, /<meta\s+name="viewport"\s+content="width=device-width,\s*initial-scale=1[^"]*"/i);
  for (const prop of ["og:type", "og:url", "og:title", "og:description", "og:image"]) {
    assert.match(html, new RegExp(`<meta\\s+property="${prop}"\\s+content="[^"]+"`, "i"), `missing ${prop}`);
  }
  for (const name of ["twitter:card", "twitter:site", "twitter:creator", "twitter:image"]) {
    assert.match(html, new RegExp(`<meta\\s+name="${name}"\\s+content="[^"]+"`, "i"), `missing ${name}`);
  }
  assert.match(html, /content="@1nc0gn30"/);
  assert.ok(html.includes("https://buy.stripe.com/3cIfZg27PdKo2D64Ocfw40X"), "missing Stripe Coffee link");
  assert.ok(html.includes("GG2eQbVh8ut1BK6j1A2tz7pSySdLpD38BgyEhGcxdXoK"), "missing Solana tip address");
  assert.doesNotMatch(html, /depay/i, "DePay reference must not exist");
  assert.doesNotMatch(html, /Free Citizen Tier|Founding Lifetime/i, "paywall tier copy must not exist");
  assert.doesNotMatch(html, /filter:\s*blur\(/i, "paywall blur lock must not exist");
});

test("guardrail: public/index.html has balanced core HTML tags and non-empty img alt attributes", () => {
  const html = read("public/index.html");
  for (const tag of ["html", "head", "body", "script", "style"]) {
    const opens = (html.match(new RegExp(`<${tag}(\\s|>)`, "gi")) || []).length;
    const closes = (html.match(new RegExp(`</${tag}>`, "gi")) || []).length;
    assert.equal(opens, closes, `unbalanced <${tag}> tags (${opens} open vs ${closes} close)`);
  }
  for (const [imgTag] of html.matchAll(/<img\b[^>]*>/gi)) {
    assert.match(imgTag, /\balt="[^"]+"/i, `img missing non-empty alt: ${imgTag}`);
  }
});
