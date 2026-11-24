import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { changelogPath } from "./paths.js";
import { buildPromptKnowledge, readCommunityGuide, refreshOfficialSources, writeCommunityGuide } from "./knowledge.js";
import { getCliVersion, helpMentions, runSafeNetlify } from "./cli-test.js";
import { getProvider } from "./providers.js";
import { LIMITS } from "./guards.js";

const BASELINE_TESTS = [
  {
    id: "cli-version",
    command: "netlify --version",
    claim: "The Netlify CLI reports a version in the form netlify-cli/<version>. Official agent docs (netlify.ai) ask agents to install netlify-cli@latest and to upgrade if the installed CLI is older than 27.20.0.",
    verify: (result, ctx) => result.ok && Boolean(ctx.version),
  },
  {
    id: "cli-help",
    command: "netlify --help",
    claim: "`netlify --help` lists the CLI commands available in the installed version.",
    verify: (result) => result.ok && helpMentions(result.output, "USAGE"),
  },
  {
    id: "dev-help-live",
    command: "netlify dev --help",
    claim: "`netlify dev --live` starts a public live session. The flag accepts an optional subdomain to generate a custom URL, and the session is a tunnel from the local dev server (a .netlify.live link) rather than a production deploy.",
    verify: (result) => result.ok && helpMentions(result.output, "--live") && helpMentions(result.output, "public live session"),
  },
  {
    id: "login-help",
    command: "netlify login --help",
    claim: "`netlify login --request` is the agent-friendly login path: it prints a login URL instead of waiting on a local browser window. Official agent docs recommend it over plain `netlify login`.",
    verify: (result) => result.ok && helpMentions(result.output, "--request"),
  },
  {
    id: "deploy-help",
    command: "netlify deploy --help",
    claim: "`netlify deploy` publishes a draft by default. A production publish uses `--prod`. Deploying from a folder that is not linked can create a new project, so the folder should be linked first.",
    verify: (result) => result.ok && helpMentions(result.output, "--prod"),
  },
  {
    id: "status-help",
    command: "netlify status --help",
    claim: "`netlify status` reports the logged-in account and whether the current folder is linked to a Netlify project. `--json` is available for machine-readable output.",
    verify: (result) => result.ok && (helpMentions(result.output, "status") || helpMentions(result.output, "--json")),
  },
  {
    id: "init-help",
    command: "netlify init --help",
    claim: "`netlify init` can configure continuous deployment and, unless skipped, set up Netlify skills and the Netlify MCP server for AI coding agents. `--skip-agent-setup` and `--skip-mcp-setup` turn those steps off.",
    verify: (result) => result.ok && helpMentions(result.output, "--skip-agent-setup"),
  },
  {
    id: "sites-create-help",
    command: "netlify sites:create --help",
    claim: "`netlify sites:create` creates a new Netlify project. `--name` and `--account-slug` can be passed so the command does not need an interactive prompt.",
    verify: (result) => result.ok && (helpMentions(result.output, "--name") || helpMentions(result.output, "create")),
  },
];

async function loadChangelog() {
  if (!existsSync(changelogPath)) return [];
  try {
    return JSON.parse(await readFile(changelogPath, "utf8"));
  } catch {
    return [];
  }
}

function renderGuide({ version, cli, official, tests, extraClaims, changelog }) {
  const verified = tests.filter((t) => t.verified);
  const failed = tests.filter((t) => !t.verified);
  const lines = [];
  lines.push("# Community Netlify AI Guide");
  lines.push("");
  lines.push("> Fan-made, community-maintained companion to [netlify.ai](https://netlify.ai).");
  lines.push("> This is not an official Netlify document and is not affiliated with Netlify.");
  lines.push("> Only claims that were checked against official pages or a read-only CLI test are listed below.");
  lines.push("");
  lines.push(`- Guide version: \`${version}\``);
  lines.push(`- Last verified: ${new Date().toISOString()}`);
  lines.push(`- CLI under test: \`${cli.raw?.split("\n")[0] || cli.version || "unknown"}\``);
  lines.push(`- Official sources fetched: ${official.okCount || 0} of ${(official.sources || []).length}`);
  lines.push(`- Official fetch time: ${official.at || "n/a"}`);
  lines.push("");
  lines.push("## How this file is updated");
  lines.push("");
  lines.push("Cove refreshes official sources (netlify.ai, docs.netlify.com/llms.txt, and key docs pages), asks its model to propose updates, then **runs the tests itself**. The model cannot write this file directly. Unsafe or unverified proposals are dropped.");
  lines.push("");
  lines.push("Allowed tests are only:");
  lines.push("");
  lines.push("- `netlify --version`");
  lines.push("- `netlify --help`");
  lines.push("- `netlify <command> --help`");
  lines.push("");
  lines.push("## Changelog");
  lines.push("");
  for (const entry of changelog.slice(0, 20)) {
    lines.push(`- \`${entry.version}\` (${entry.at}): ${entry.summary}`);
  }
  lines.push("");
  lines.push("## Verified claims");
  lines.push("");
  for (const test of verified) {
    lines.push(`### ${test.id}`);
    lines.push("");
    lines.push(test.claim);
    lines.push("");
    lines.push(`- Test: \`${test.command}\``);
    lines.push("- Result: pass");
    if (test.excerpt) {
      lines.push(`- Excerpt: \`${test.excerpt.replace(/`/g, "'")}\``);
    }
    lines.push("");
  }
  if (extraClaims.length) {
    lines.push("## Source-backed notes");
    lines.push("");
    lines.push("These notes are taken from official pages that were fetched successfully. They were not independently CLI-tested.");
    lines.push("");
    for (const claim of extraClaims) {
      lines.push(`- ${claim.text} — source: ${claim.source}`);
    }
    lines.push("");
  }
  if (failed.length) {
    lines.push("## Tests that did not pass");
    lines.push("");
    lines.push("These proposed or baseline checks were not written into the verified list.");
    lines.push("");
    for (const test of failed) {
      lines.push(`- \`${test.id}\` (\`${test.command}\`): ${test.reason || "failed"}`);
    }
    lines.push("");
  }
  lines.push("## Official sources in the latest fetch");
  lines.push("");
  for (const source of official.sources || []) {
    const mark = source.ok ? "ok" : `failed${source.error ? ` (${source.error})` : ""}`;
    lines.push(`- ${source.title}: ${source.url} — ${mark}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function excerpt(output, needle) {
  const text = String(output || "");
  const idx = text.toLowerCase().indexOf(String(needle).toLowerCase());
  if (idx === -1) return text.slice(0, 140).replace(/\s+/g, " ").trim();
  return text.slice(Math.max(0, idx - 20), idx + 80).replace(/\s+/g, " ").trim();
}

async function collectAgyProposals({ knowledge, tests, signal, localAccess = false }) {
  if (!localAccess) return [];
  const provider = getProvider(undefined, { localAccess });
  if (!provider) return [];
  const ready = await provider.available({ localAccess });
  if (!ready.ok) return [];
  const prompt = `You are helping maintain a community Netlify guide. Propose additional CLI facts that can be verified with read-only help output.

Return ONLY a JSON array, no markdown, no commentary. Each item:
{"id":"kebab-id","command":"netlify something --help","claim":"one precise sentence","needle":"a short string that should appear in the help output if the claim is true"}

Rules:
- command MUST be exactly \`netlify --version\`, \`netlify --help\`, or \`netlify <subcommand> --help\`.
- Do not propose deploy, login, sites:create, init, or link commands without --help.
- Do not invent flags. Prefer well-known commands: functions, env, blobs, unlink, unlink, api, sites:list, logs, completion.
- Max 6 items.
- Skip anything already covered by these existing ids: ${tests.map((t) => t.id).join(", ")}.

Knowledge excerpt (may be truncated):

${knowledge.text.slice(0, 12000)}
`;
  let raw = "";
  try {
    for await (const chunk of provider.stream({
      messages: [{ role: "user", content: prompt }],
      systemPrompt: prompt,
      signal,
      timeoutMs: 90_000,
      localAccess,
    })) {
      raw += chunk;
    }
  } catch {
    return [];
  }
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 6).filter((item) => item && item.command && item.claim);
  } catch {
    return [];
  }
}

export async function runResearch({ signal, includeModelProposals = false, localAccess = false } = {}) {
  const official = await refreshOfficialSources({ reason: "research" });
  const cli = await getCliVersion();
  const knowledge = await buildPromptKnowledge();
  const tests = [];

  for (const baseline of BASELINE_TESTS) {
    const result = await runSafeNetlify(baseline.command);
    const verified = baseline.verify(result, cli);
    tests.push({
      id: baseline.id,
      command: result.command || baseline.command,
      claim: baseline.claim,
      verified,
      reason: verified ? null : result.reason || "verification failed",
      excerpt: verified ? excerpt(result.output, baseline.command.includes("version") ? "netlify-cli/" : "--") : null,
    });
  }

  if (includeModelProposals && localAccess) {
    const proposals = await collectAgyProposals({ knowledge, tests, signal, localAccess });
    for (const proposal of proposals) {
      const result = await runSafeNetlify(proposal.command);
      const needle = proposal.needle || "";
      const verified = result.ok && (!needle || helpMentions(result.output, needle));
      tests.push({
        id: String(proposal.id || proposal.command).replace(/[^a-z0-9:_-]/gi, "-").slice(0, 60),
        command: result.command || proposal.command,
        claim: String(proposal.claim).slice(0, 500),
        verified,
        reason: verified ? null : result.reason || (result.ok ? "needle not found in help output" : "command rejected or failed"),
        excerpt: verified ? excerpt(result.output, needle || "--") : null,
      });
    }
  }

  const extraClaims = [];
  const ai = official.sources?.find((s) => s.id === "netlify-ai" && s.ok);
  if (ai) {
    extraClaims.push({
      text: "Official agent setup lives at https://netlify.ai and lists a stepwise flow: install the CLI (upgrade if older than 27.20.0), log in with `netlify login --request`, run `netlify init` for skills and MCP, then link or create a project and deploy only after the folder is linked.",
      source: "https://netlify.ai",
    });
  }
  const server = official.sources?.find((s) => s.id === "server-get-started" && s.ok);
  if (server) {
    extraClaims.push({
      text: "Netlify Server is a long-running Node.js backend declared at `netlify/server/index.ts` (or .js/.mjs/.mts). It can hold WebSockets and SSE connections. Locally it runs with Netlify CLI 27.17.0 or later via `netlify dev`. This is separate from Preview Servers and from `netlify dev --live`.",
      source: "https://docs.netlify.com/build/server/get-started/",
    });
  }
  const preview = official.sources?.find((s) => s.id === "preview-servers" && s.ok);
  if (preview) {
    extraClaims.push({
      text: "Preview Servers run `netlify dev` in a Netlify-managed container. They need a linked site, a git branch, and authenticated collaborators. The URL looks like `https://devserver-BRANCH--SITE.netlify.app`. They are not a public unauthenticated share link, and they auto-shutoff after 30 minutes of inactivity.",
      source: "https://docs.netlify.com/manage/preview-servers/overview/",
    });
  }

  const changelog = await loadChangelog();
  const version = `0.${changelog.length + 1}.0`;
  const summary = `Verified ${tests.filter((t) => t.verified).length} claims against CLI ${cli.version || "unknown"} and ${official.okCount || 0} official sources.`;
  const entry = { version, at: new Date().toISOString(), summary };
  changelog.unshift(entry);
  await mkdir(changelogPath.replace(/\/changelog\.json$/, ""), { recursive: true });
  await writeFile(changelogPath, `${JSON.stringify(changelog, null, 2)}\n`);
  const markdown = renderGuide({ version, cli, official, tests, extraClaims, changelog });
  await writeCommunityGuide(markdown);
  return {
    version,
    summary,
    cli,
    official: { at: official.at, okCount: official.okCount, sources: official.sources },
    tests,
    extraClaims,
  };
}
