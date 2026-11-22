/**
 * Conversation auto-analysis: a fixed tag vocabulary, a cheap keyword
 * fallback, and a short model prompt when the provider is available.
 */
export const TAGS = [
  "Deploys",
  "Functions",
  "Server",
  "Redirects",
  "Forms",
  "Blobs",
  "DNS/Domains",
  "CLI",
  "Billing",
  "Debugging",
];

const KEYWORDS = {
  Deploys: [
    "deploy", "deploys", "deployment", "production publish", "publish the site",
    "build hook", "atomic deploy", "deploy preview", "production branch", "rollback",
  ],
  Functions: [
    "netlify function", "netlify functions", "background function", "scheduled function",
    "lambda", "serverless function", "functions directory",
  ],
  Server: [
    "netlify server", "long-running", "server/index.js", "@netlify/server",
    "netlify server vs", "persistent process", "early access server",
  ],
  Redirects: [
    "redirect", "redirects", "_redirects", "rewrite", "rewrites", "splat",
    "status = 301", "force = true",
  ],
  Forms: [
    "netlify form", "netlify forms", "data-netlify", "form-name", "honeypot",
    "form submission", "form notifications",
  ],
  Blobs: [
    "netlify blob", "netlify blobs", "blob store", "blobs api", "getstore",
  ],
  "DNS/Domains": [
    "custom domain", "dns", "nameserver", "name server", "https certificate",
    "ssl", "apex domain", "www redirect", "domain alias", "netlify dns",
  ],
  CLI: [
    "netlify cli", "netlify dev", "netlify login", "netlify link", "netlify init",
    "--live", "netlify.toml", "cli command", "npx netlify",
  ],
  Billing: [
    "billing", "invoice", "pricing plan", "pro plan", "enterprise plan",
    "credit card", "team seat", "quota", "bandwidth overage",
  ],
  Debugging: [
    "error", "failed", "failure", "not working", "doesn't work", "timeout",
    "stack trace", "500", "build log", "function log", "debug", "broken",
  ],
};

export function keywordAnalyze(messages = []) {
  const text = (Array.isArray(messages) ? messages : [])
    .map((m) => String(m?.content || ""))
    .join("\n")
    .toLowerCase();
  const tags = TAGS.filter((tag) =>
    (KEYWORDS[tag] || []).some((word) => text.includes(word.toLowerCase())),
  );
  return { title: fallbackTitle(messages), tags, source: "keywords" };
}

export function fallbackTitle(messages = []) {
  const first = (Array.isArray(messages) ? messages : []).find((m) => m?.role === "user" && String(m.content || "").trim());
  if (!first) return "New conversation";
  const clean = String(first.content).replace(/\s+/g, " ").trim();
  if (clean.length <= 56) return clean;
  return `${clean.slice(0, 53).trim()}…`;
}

export function analyzePrompt(messages = []) {
  const excerpt = (Array.isArray(messages) ? messages : [])
    .slice(-8)
    .map((m) => `${m.role === "user" ? "User" : "Cove"}: ${String(m.content || "").slice(0, 800)}`)
    .join("\n\n");
  return {
    systemPrompt: `You title and tag a short chat about the Netlify platform for a fan-made community guide.
Reply with JSON only, no markdown, in this exact shape:
{"title":"short title, max 8 words","tags":["Tag"]}
Use only these tags: ${TAGS.join(", ")}.
Pick 1-3 of the most relevant tags. If none fit, use an empty tags array.
The title should be specific and human, not "Conversation" or "Chat".`,
    userContent: excerpt || "Empty conversation.",
  };
}

export function parseAnalyzeReply(raw, messages = []) {
  const fallback = keywordAnalyze(messages);
  const text = String(raw || "").trim();
  if (!text) return fallback;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  try {
    const parsed = JSON.parse(match[0]);
    const title = String(parsed.title || "").replace(/\s+/g, " ").trim();
    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.map((t) => String(t).trim()).filter((t) => TAGS.includes(t))
      : [];
    return {
      title: title || fallback.title,
      tags: tags.length ? [...new Set(tags)].slice(0, 3) : fallback.tags,
      source: "model",
    };
  } catch {
    return fallback;
  }
}
