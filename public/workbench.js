/**
 * Interactive in-browser Netlify Developer Workbench:
 * 1. netlify.toml Studio & Real-Time Linter
 * 2. _redirects / Rewrite Rule Simulator
 * 3. Netlify CLI Command Forge
 * 100% client-side, zero external dependencies.
 */
(() => {
  const wbRoot = document.getElementById("workbench");
  if (!wbRoot) return;

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  /* ---- Tab Switching ---- */
  function openTool(name) {
    const valid = ["toml", "redirects", "cli"].includes(name) ? name : "toml";
    wbRoot.querySelectorAll("[data-wb-tab]").forEach((btn) => {
      const on = btn.dataset.wbTab === valid;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", String(on));
    });
    ["toml", "redirects", "cli"].forEach((id) => {
      const panel = document.getElementById(`wb-panel-${id}`);
      if (panel) panel.hidden = id !== valid;
    });
    window.CoveMascot?.playTone?.("click");
  }

  wbRoot.querySelectorAll("[data-wb-tab]").forEach((btn) => {
    btn.addEventListener("click", () => openTool(btn.dataset.wbTab));
  });

  document.querySelectorAll("[data-open-tool]").forEach((btn) => {
    btn.addEventListener("click", () => {
      openTool(btn.dataset.openTool);
      wbRoot.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  /* ---- Tool 1: netlify.toml Studio & Linter ---- */
  const TOML_PRESETS = {
    spa: { publish: "dist", command: "npm run build", node: "22", functions: "", spa: true, headers: true, cache: true, dev: false },
    functions: { publish: "public", command: "npm run build", node: "22", functions: "netlify/functions", spa: true, headers: true, cache: false, dev: true },
    edge: { publish: "dist", command: "npm run build", node: "22", functions: "netlify/functions", spa: true, headers: true, cache: true, dev: true },
    monorepo: { publish: "apps/web/dist", command: "npm run build --workspace=web", node: "22", functions: "apps/web/netlify/functions", spa: true, headers: true, cache: true, dev: false },
  };

  const tomlEls = {
    publish: document.getElementById("toml-publish"),
    command: document.getElementById("toml-command"),
    node: document.getElementById("toml-node"),
    functions: document.getElementById("toml-functions"),
    spa: document.getElementById("toml-spa"),
    headers: document.getElementById("toml-headers"),
    cache: document.getElementById("toml-cache"),
    dev: document.getElementById("toml-dev"),
    output: document.getElementById("toml-output"),
    lint: document.getElementById("toml-lint"),
    copy: document.getElementById("toml-copy"),
    download: document.getElementById("toml-download"),
    ask: document.getElementById("toml-ask-cove"),
  };

  function generateToml() {
    const pub = (tomlEls.publish?.value || "dist").trim();
    const cmd = (tomlEls.command?.value || "").trim();
    const nodeVer = (tomlEls.node?.value || "").trim();
    const fnDir = (tomlEls.functions?.value || "").trim();

    const lines = ["[build]"];
    if (cmd) lines.push(`  command = "${cmd}"`);
    lines.push(`  publish = "${pub}"`);
    if (nodeVer) {
      lines.push("", "[build.environment]", `  NODE_VERSION = "${nodeVer}"`);
    }
    if (fnDir) {
      lines.push("", "[functions]", `  directory = "${fnDir}"`, '  node_bundler = "esbuild"');
    }
    if (tomlEls.dev?.checked) {
      lines.push("", "[dev]", `  publish = "${pub}"`, "  port = 8888", "  autoLaunch = false");
    }
    if (tomlEls.headers?.checked) {
      lines.push(
        "",
        "[[headers]]",
        '  for = "/*"',
        "  [headers.values]",
        '    X-Frame-Options = "SAMEORIGIN"',
        '    X-Content-Type-Options = "nosniff"',
        '    Referrer-Policy = "strict-origin-when-cross-origin"'
      );
    }
    if (tomlEls.cache?.checked) {
      lines.push(
        "",
        "[[headers]]",
        '  for = "/assets/*"',
        "  [headers.values]",
        '    Cache-Control = "public, max-age=31536000, immutable"'
      );
    }
    if (tomlEls.spa?.checked) {
      lines.push(
        "",
        "[[redirects]]",
        '  from = "/*"',
        '  to = "/index.html"',
        "  status = 200"
      );
    }
    const text = lines.join("\n") + "\n";
    if (tomlEls.output) tomlEls.output.value = text;
    lintToml(text);
  }

  function lintToml(raw) {
    if (!tomlEls.lint) return;
    const issues = [];
    const lines = String(raw || "").split(/\r?\n/);
    let hasPublish = false;
    let hasHeaders = false;
    let catchAllIndex = -1;
    let redirectAfterCatchAll = false;

    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      if (trimmed.startsWith("[") && !trimmed.endsWith("]")) {
        issues.push({ level: "error", msg: `Line ${idx + 1}: Unclosed section bracket ${trimmed}` });
      }
      if (/^publish\s*=\s*"[^"]+"/.test(trimmed)) hasPublish = true;
      if (trimmed === "[[headers]]") hasHeaders = true;
      if (/^from\s*=\s*"\/\*"/.test(trimmed)) catchAllIndex = idx;
      if (catchAllIndex >= 0 && idx > catchAllIndex && /^from\s*=/.test(trimmed)) {
        redirectAfterCatchAll = true;
      }
      const quotes = (trimmed.match(/(?<!\\)"/g) || []).length;
      if (quotes % 2 !== 0) {
        issues.push({ level: "error", msg: `Line ${idx + 1}: Unbalanced double quotes.` });
      }
    });

    if (!hasPublish) {
      issues.push({ level: "warn", msg: 'Missing publish = "..." inside [build]. Netlify needs a publish directory.' });
    }
    if (!hasHeaders) {
      issues.push({ level: "info", msg: "No [[headers]] block detected. Consider adding security headers." });
    }
    if (redirectAfterCatchAll) {
      issues.push({ level: "warn", msg: 'A redirect appears after from = "/*". Catch-all rules should be last.' });
    }

    if (!issues.length) {
      tomlEls.lint.innerHTML = `<div class="lint-item is-ok"><span class="lint-badge">PASS</span><span>Valid netlify.toml structure — publish dir, headers, and rule order look clean.</span></div>`;
      return;
    }
    tomlEls.lint.innerHTML = issues
      .map((item) => `<div class="lint-item is-${item.level}"><span class="lint-badge">${item.level.toUpperCase()}</span><span>${escapeHtml(item.msg)}</span></div>`)
      .join("");
  }

  document.getElementById("toml-presets")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-preset]");
    if (!btn) return;
    const preset = TOML_PRESETS[btn.dataset.preset];
    if (!preset) return;
    document.querySelectorAll("#toml-presets .chip-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
    if (tomlEls.publish) tomlEls.publish.value = preset.publish;
    if (tomlEls.command) tomlEls.command.value = preset.command;
    if (tomlEls.node) tomlEls.node.value = preset.node;
    if (tomlEls.functions) tomlEls.functions.value = preset.functions;
    if (tomlEls.spa) tomlEls.spa.checked = preset.spa;
    if (tomlEls.headers) tomlEls.headers.checked = preset.headers;
    if (tomlEls.cache) tomlEls.cache.checked = preset.cache;
    if (tomlEls.dev) tomlEls.dev.checked = preset.dev;
    generateToml();
  });

  [tomlEls.publish, tomlEls.command, tomlEls.node, tomlEls.functions, tomlEls.spa, tomlEls.headers, tomlEls.cache, tomlEls.dev]
    .filter(Boolean)
    .forEach((el) => el.addEventListener("input", generateToml));

  tomlEls.output?.addEventListener("input", () => lintToml(tomlEls.output.value));

  tomlEls.copy?.addEventListener("click", async () => {
    if (!tomlEls.output) return;
    await navigator.clipboard.writeText(tomlEls.output.value).catch(() => {});
    tomlEls.copy.textContent = "Copied ✓";
    window.CoveMascot?.playTone?.("success");
    window.setTimeout(() => { tomlEls.copy.textContent = "Copy"; }, 1400);
  });

  tomlEls.download?.addEventListener("click", () => {
    if (!tomlEls.output) return;
    const blob = new Blob([tomlEls.output.value], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "netlify.toml";
    a.click();
    URL.revokeObjectURL(url);
    window.CoveMascot?.say?.("Downloaded netlify.toml — drop it into your repository root.");
  });

  tomlEls.ask?.addEventListener("click", () => {
    const content = tomlEls.output?.value || "";
    window.CoveAsk?.(`Review this netlify.toml for any edge cases or improvements:\n\n\`\`\`toml\n${content.trim()}\n\`\`\``);
  });

  /* ---- Tool 2: Redirect & Rewrite Simulator ---- */
  const redirEls = {
    path: document.getElementById("redir-test-path"),
    rules: document.getElementById("redir-rules"),
    run: document.getElementById("redir-run"),
    result: document.getElementById("redir-result"),
    ask: document.getElementById("redir-ask-cove"),
  };

  function parseRedirectLine(line, lineNo) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return null;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) return { lineNo, invalid: true, raw: trimmed };
    const from = parts[0];
    const to = parts[1];
    const rawStatus = parts[2] || "301";
    const force = rawStatus.endsWith("!");
    const status = parseInt(rawStatus.replace("!", ""), 10) || 301;
    return { lineNo, from, to, status, force, raw: trimmed };
  }

  function matchRedirect(ruleFrom, reqPath) {
    const cleanReq = reqPath.startsWith("/") ? reqPath : `/${reqPath}`;
    const fromParts = ruleFrom.split("/").filter(Boolean);
    const reqParts = cleanReq.split("/").filter(Boolean);
    const params = {};

    if (ruleFrom === "/*") {
      return { matched: true, params: { splat: cleanReq.slice(1) } };
    }
    for (let i = 0; i < fromParts.length; i += 1) {
      const seg = fromParts[i];
      if (seg === "*") {
        params.splat = reqParts.slice(i).join("/");
        return { matched: true, params };
      }
      if (i >= reqParts.length) return { matched: false };
      if (seg.startsWith(":")) {
        params[seg.slice(1)] = reqParts[i];
      } else if (seg !== reqParts[i]) {
        return { matched: false };
      }
    }
    if (fromParts.length !== reqParts.length) return { matched: false };
    return { matched: true, params };
  }

  function applyTarget(to, params) {
    let out = to.replaceAll(":splat", params.splat ?? "");
    Object.entries(params).forEach(([k, v]) => {
      if (k !== "splat") out = out.replaceAll(`:${k}`, v);
    });
    return out;
  }

  function runRedirectSimulation() {
    if (!redirEls.result) return;
    const reqPath = (redirEls.path?.value || "/").trim() || "/";
    const lines = String(redirEls.rules?.value || "").split(/\r?\n/);
    const parsed = lines.map((l, i) => parseRedirectLine(l, i + 1)).filter(Boolean);

    let winner = null;
    const shadowed = [];
    let sawCatchAll = false;

    for (const rule of parsed) {
      if (rule.invalid) continue;
      if (sawCatchAll) shadowed.push(rule);
      if (!winner) {
        const res = matchRedirect(rule.from, reqPath);
        if (res.matched) {
          winner = { rule, target: applyTarget(rule.to, res.params), params: res.params };
        }
      }
      if (rule.from === "/*") sawCatchAll = true;
    }

    const warnings = shadowed.length
      ? `<div class="lint-item is-warn"><span class="lint-badge">SHADOWED</span><span>${shadowed.length} rule(s) appear after <code>/*</code> and will never run.</span></div>`
      : "";

    if (!winner) {
      redirEls.result.innerHTML = `
        <div class="sim-summary is-miss">
          <p class="eyebrow">NO RULE MATCHED</p>
          <h3><code>${escapeHtml(reqPath)}</code> → Static file lookup (or 404)</h3>
          <p>Netlify will serve a matching file from your publish directory, or <code>404.html</code> if none exists.</p>
        </div>
        ${warnings}`;
      return;
    }

    const mode = winner.rule.status === 200 ? "Internal Rewrite (URL stays the same)" : `HTTP ${winner.rule.status} Redirect`;
    const forceNote = winner.rule.force ? "Forced (!) — overrides existing static files." : "Standard — only runs if no static file exists at this path.";
    const paramEntries = Object.entries(winner.params);
    const paramHtml = paramEntries.length
      ? `<div class="sim-params">${paramEntries.map(([k, v]) => `<span><code>:${escapeHtml(k)}</code> = <strong>${escapeHtml(v || "(empty)")}</strong></span>`).join("")}</div>`
      : "";

    redirEls.result.innerHTML = `
      <div class="sim-summary is-hit">
        <p class="eyebrow">MATCHED LINE ${winner.rule.lineNo} · ${escapeHtml(mode)}</p>
        <h3><code>${escapeHtml(reqPath)}</code> → <code>${escapeHtml(winner.target)}</code></h3>
        <div class="sim-meta">
          <span class="sim-pill">Status ${winner.rule.status}${winner.rule.force ? "!" : ""}</span>
          <span>${escapeHtml(forceNote)}</span>
        </div>
        ${paramHtml}
      </div>
      ${warnings}`;
  }

  document.getElementById("redir-samples")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-path]");
    if (!btn || !redirEls.path) return;
    redirEls.path.value = btn.dataset.path;
    runRedirectSimulation();
  });
  redirEls.run?.addEventListener("click", runRedirectSimulation);
  redirEls.path?.addEventListener("input", runRedirectSimulation);
  redirEls.rules?.addEventListener("input", runRedirectSimulation);
  redirEls.ask?.addEventListener("click", () => {
    const rules = redirEls.rules?.value || "";
    const path = redirEls.path?.value || "/";
    window.CoveAsk?.(`Check my Netlify _redirects rules for path \`${path}\`:\n\n\`\`\`text\n${rules.trim()}\n\`\`\``);
  });

  /* ---- Tool 3: Netlify CLI Command Forge ---- */
  const CLI_SPECS = {
    dev: {
      base: "netlify dev",
      desc: "Runs your local dev server with Netlify Functions, Edge Functions, redirects, and env vars injected.",
      flags: [
        { id: "live", flag: "--live", label: "Share via temporary public .netlify.live tunnel", on: false },
        { id: "port", flag: "--port 8888", label: "Bind local proxy to port 8888", on: true },
        { id: "no-open", flag: "--no-open", label: "Do not auto-open browser tab", on: true },
        { id: "offline", flag: "--offline", label: "Skip remote Netlify API calls", on: false },
      ],
    },
    deploy: {
      base: "netlify deploy",
      desc: "Uploads a build folder as a draft preview URL (or live production site with --prod).",
      flags: [
        { id: "prod", flag: "--prod", label: "Deploy directly to production URL", on: false },
        { id: "dir", flag: "--dir=dist", label: "Specify publish directory (dist)", on: true },
        { id: "build", flag: "--build", label: "Run build command before deploying", on: false },
        { id: "json", flag: "--json", label: "Output machine-readable JSON", on: false },
      ],
    },
    functions: {
      base: "netlify functions:invoke",
      desc: "Test or inspect serverless functions locally against netlify dev.",
      flags: [
        { id: "name", flag: "hello", label: "Target function name (hello)", on: true },
        { id: "payload", flag: '--payload \'{"ping":true}\'', label: "Send JSON request body", on: true },
        { id: "no-identity", flag: "--no-identity", label: "Simulate unauthenticated request", on: false },
      ],
    },
    env: {
      base: "netlify env:list",
      desc: "Inspect or synchronize environment variables across deploy contexts.",
      flags: [
        { id: "plain", flag: "--plain", label: "Print KEY=value format", on: true },
        { id: "context", flag: "--context production", label: "Scope to production context", on: false },
        { id: "json", flag: "--json", label: "Output JSON for scripts", on: false },
      ],
    },
    blobs: {
      base: "netlify blobs:list",
      desc: "Inspect and manage Netlify Blobs key-value stores from the CLI.",
      flags: [
        { id: "store", flag: "cove-cache", label: "Store name (cove-cache)", on: true },
        { id: "json", flag: "--json", label: "Output JSON list", on: false },
      ],
    },
  };

  let activeCli = "dev";
  const cliFlagsHost = document.getElementById("cli-flags");
  const cliPreview = document.getElementById("cli-preview");
  const cliExplain = document.getElementById("cli-explain");
  const cliCopy = document.getElementById("cli-copy");
  const cliAsk = document.getElementById("cli-ask-cove");

  function renderCliFlags() {
    const spec = CLI_SPECS[activeCli];
    if (!spec || !cliFlagsHost) return;
    cliFlagsHost.innerHTML = spec.flags
      .map((f) => `
        <label class="wb-toggle">
          <input type="checkbox" data-cli-flag="${escapeHtml(f.id)}" ${f.on ? "checked" : ""} />
          <span><code>${escapeHtml(f.flag)}</code> — ${escapeHtml(f.label)}</span>
        </label>`)
      .join("");
    updateCliPreview();
  }

  function updateCliPreview() {
    const spec = CLI_SPECS[activeCli];
    if (!spec) return;
    const activeFlags = spec.flags.filter((f) => f.on).map((f) => f.flag);
    const cmd = [spec.base, ...activeFlags].join(" ");
    if (cliPreview) cliPreview.textContent = cmd;
    if (cliExplain) {
      cliExplain.innerHTML = `<p>${escapeHtml(spec.desc)}</p>`;
    }
  }

  document.getElementById("cli-commands")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-cmd]");
    if (!btn || !CLI_SPECS[btn.dataset.cmd]) return;
    activeCli = btn.dataset.cmd;
    document.querySelectorAll("#cli-commands .chip-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
    renderCliFlags();
  });

  cliFlagsHost?.addEventListener("change", (e) => {
    const box = e.target.closest("[data-cli-flag]");
    if (!box) return;
    const item = CLI_SPECS[activeCli]?.flags.find((f) => f.id === box.dataset.cliFlag);
    if (item) item.on = box.checked;
    updateCliPreview();
  });

  cliCopy?.addEventListener("click", async () => {
    const text = cliPreview?.textContent || "";
    await navigator.clipboard.writeText(text).catch(() => {});
    cliCopy.textContent = "Copied ✓";
    window.CoveMascot?.playTone?.("success");
    window.setTimeout(() => { cliCopy.textContent = "Copy"; }, 1400);
  });

  cliAsk?.addEventListener("click", () => {
    const cmd = cliPreview?.textContent || "netlify dev";
    window.CoveAsk?.(`Explain what \`${cmd}\` does and any flags or gotchas I should know.`);
  });

  /* ---- Initial Render ---- */
  generateToml();
  runRedirectSimulation();
  renderCliFlags();

  window.CoveWorkbench = { openTool };
})();
