const sessionId = (() => {
  const key = "cove-session";
  let id = localStorage.getItem(key);
  if (!id || !/^[a-zA-Z0-9_-]{8,80}$/.test(id)) {
    id = crypto.randomUUID().replaceAll("-", "");
    localStorage.setItem(key, id);
  }
  return id;
})();

const state = {
  messages: [],
  busy: false,
  abortController: null,
  slashIndex: 0,
};

const els = {
  transcript: document.getElementById("transcript"),
  composer: document.getElementById("composer"),
  prompt: document.getElementById("prompt"),
  send: document.getElementById("send"),
  stop: document.getElementById("stop-stream"),
  buoy: document.getElementById("buoy"),
  statusProvider: document.getElementById("status-provider"),
  statusCli: document.getElementById("status-cli"),
  statusKnowledge: document.getElementById("status-knowledge"),
  refresh: document.getElementById("refresh-knowledge"),
  research: document.getElementById("run-research"),
  share: document.getElementById("share-guide"),
  hint: document.getElementById("job-hint"),
  slashMenu: document.getElementById("slash-menu"),
  slashTrigger: document.getElementById("slash-trigger"),
  followupRow: document.getElementById("followup-row"),
  voiceBtn: document.getElementById("voice-btn"),
  themeBtn: document.getElementById("toggle-theme"),
};

/* ---- Theme Persistence (Warm Cream Light / Obsidian Teal Dark) ---- */
function applyTheme(theme) {
  const next = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("cove-theme", next);
  if (els.themeBtn) els.themeBtn.setAttribute("aria-pressed", String(next === "dark"));
}

applyTheme(localStorage.getItem("cove-theme") || "light");
els.themeBtn?.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  window.CoveMascot?.playTone?.("click");
  window.CoveMascot?.say?.(next === "dark" ? "Switched to Obsidian Bot Console mode." : "Switched to Warm Cream Editorial mode.");
});

/* ---- Telemetry Tile Shortcuts ---- */
document.getElementById("tile-provider")?.addEventListener("click", () => {
  window.CoveAccount?.showAccountTab?.("providers");
  window.CoveAccount?.openDrawer?.();
});
document.getElementById("tile-account")?.addEventListener("click", () => {
  window.CoveAccount?.showAccountTab?.("netlify");
  window.CoveAccount?.openDrawer?.();
});

function setState(mode, opts) {
  if (window.CoveMascot) {
    window.CoveMascot.setMood(mode, opts);
    return;
  }
  els.buoy.dataset.state = mode;
  els.buoy.dataset.mood = mode;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderMarkdown(raw) {
  const fences = [];
  let text = String(raw).replace(/```([a-zA-Z0-9_.+-]+)?\r?\n([\s\S]*?)```/g, (_, lang, code) => {
    const i = fences.length;
    const cleanLang = escapeHtml(lang || "code");
    const cleanCode = escapeHtml(code.trimEnd());
    fences.push(
      `<div class="code-wrap"><div class="code-bar"><span>${cleanLang}</span><button type="button" class="copy-code" data-copy-code="1">Copy</button></div><pre><code class="lang-${cleanLang}">${cleanCode}</code></pre></div>`
    );
    return `\u0000FENCE${i}\u0000`;
  });
  text = escapeHtml(text);
  text = text.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  text = text.replace(/^## (.+)$/gm, "<h3>$1</h3>");
  text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|\n)- (.+)/g, "$1<li>$2</li>");
  text = text.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
  text = text.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>');
  text = text
    .split(/\n{2,}/)
    .map((block) => {
      if (block.startsWith("<ul>") || block.startsWith("<pre>") || block.startsWith("<h3>") || block.includes("\u0000FENCE")) return block;
      return `<p>${block.replaceAll("\n", "<br>")}</p>`;
    })
    .join("");
  text = text.replace(/\u0000FENCE(\d+)\u0000/g, (_, i) => fences[Number(i)]);
  return text;
}

function scrollTranscript() {
  requestAnimationFrame(() => {
    els.transcript.scrollTop = els.transcript.scrollHeight;
  });
}

function addBubble(role, content, { streaming = false } = {}) {
  const li = document.createElement("li");
  li.className = `bubble ${role}`;
  const nowLabel = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const copyAction = role === "assistant" && !streaming
    ? `<button type="button" class="bubble-copy" data-copy-bubble="1" title="Copy answer">Copy</button>`
    : "";
  li.innerHTML = `<div class="bubble-meta"><span class="who">${role === "user" ? "You" : "Cove"}</span><span class="bubble-time">${escapeHtml(nowLabel)}</span>${copyAction}</div><div class="body"></div>`;
  const body = li.querySelector(".body");
  body.innerHTML = role === "assistant" ? renderMarkdown(content || "") : escapeHtml(content || "").replaceAll("\n", "<br>");
  if (streaming) body.classList.add("streaming");
  if (role === "assistant" && String(content || "").startsWith("Hi, I’m Cove")) li.classList.add("welcome");
  els.transcript.appendChild(li);
  scrollTranscript();
  return { li, body };
}

/* Delegate copy buttons inside transcript */
els.transcript?.addEventListener("click", async (e) => {
  const codeBtn = e.target.closest("[data-copy-code]");
  if (codeBtn) {
    const code = codeBtn.closest(".code-wrap")?.querySelector("code")?.textContent || "";
    await navigator.clipboard.writeText(code).catch(() => {});
    codeBtn.textContent = "Copied ✓";
    window.CoveMascot?.playTone?.("click");
    window.setTimeout(() => { codeBtn.textContent = "Copy"; }, 1400);
    return;
  }
  const bubbleBtn = e.target.closest("[data-copy-bubble]");
  if (bubbleBtn) {
    const text = bubbleBtn.closest("li")?.querySelector(".body")?.innerText || "";
    await navigator.clipboard.writeText(text).catch(() => {});
    bubbleBtn.textContent = "Copied ✓";
    window.CoveMascot?.playTone?.("click");
    window.setTimeout(() => { bubbleBtn.textContent = "Copy"; }, 1400);
  }
});

function renderFollowups(replyText) {
  if (!els.followupRow) return;
  const lower = String(replyText || "").toLowerCase();
  const picks = [];
  if (lower.includes("netlify.toml") || lower.includes("[build]") || lower.includes("headers")) {
    picks.push({ label: "Open netlify.toml Studio", tool: "toml" });
  }
  if (lower.includes("redirect") || lower.includes("rewrite") || lower.includes("301") || lower.includes("200")) {
    picks.push({ label: "Simulate redirects", tool: "redirects" });
  }
  if (lower.includes("netlify dev") || lower.includes("netlify deploy") || lower.includes("cli")) {
    picks.push({ label: "Open CLI Forge", tool: "cli" });
  }
  if (!picks.length) {
    picks.push({ label: "Show a netlify.toml example", q: "Show me a minimal netlify.toml example for that." });
  }
  picks.push({ label: "Any gotchas?", q: "What are the top gotchas or common mistakes to avoid here?" });
  els.followupRow.innerHTML = picks
    .slice(0, 3)
    .map((p) => p.tool
      ? `<button type="button" class="followup-chip is-tool" data-followup-tool="${escapeHtml(p.tool)}">${escapeHtml(p.label)} →</button>`
      : `<button type="button" class="followup-chip" data-followup-q="${escapeHtml(p.q)}">${escapeHtml(p.label)}</button>`)
    .join("");
  els.followupRow.hidden = false;
}

els.followupRow?.addEventListener("click", (e) => {
  const toolBtn = e.target.closest("[data-followup-tool]");
  if (toolBtn) {
    window.CoveWorkbench?.openTool?.(toolBtn.dataset.followupTool);
    document.getElementById("workbench")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const qBtn = e.target.closest("[data-followup-q]");
  if (qBtn) sendQuestion(qBtn.dataset.followupQ);
});

function setBusy(busy) {
  state.busy = busy;
  els.send.disabled = busy;
  els.prompt.disabled = busy;
  if (els.stop) els.stop.hidden = !busy;
  if (els.send) els.send.hidden = busy;
  document.body.dataset.coveBusy = busy ? "true" : "false";
}

els.stop?.addEventListener("click", () => {
  if (state.abortController) {
    state.abortController.abort();
    state.abortController = null;
    window.CoveMascot?.say?.("Stopped streaming.");
  }
});

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "x-cove-session": sessionId,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) {
    const rawMsg = typeof data === "object" ? data.error : data;
    const message = /<!doctype|<html/i.test(String(rawMsg || ""))
      ? `API endpoint unavailable (${res.status}). In-browser workbench tools remain active.`
      : rawMsg;
    throw new Error(message || `Request failed (${res.status})`);
  }
  return data;
}

function formatTime(iso) {
  if (!iso) return "not fetched yet";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET";
}

async function loadStatus() {
  try {
    const status = await api("/api/status");
    const synced = window.CoveProviders?.syncStatus?.();
    if (!synced) {
      els.statusProvider.textContent = status.provider.available
        ? status.provider.label
        : status.provider.reason || "unavailable";
    }
    els.statusCli.textContent = status.cli.raw || status.cli.version || "unknown";
    const k = status.knowledge;
    els.statusKnowledge.textContent = k.refreshedAt
      ? `${k.okCount} sources · ${formatTime(k.refreshedAt)}`
      : "not fetched yet";
  } catch (err) {
    els.statusProvider.textContent = "unreachable";
    els.hint.textContent = err.message;
  }
}

async function readSseReply(res, onToken) {
  const type = res.headers.get("content-type") || "";
  if (!res.body || !type.includes("text/event-stream")) return null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reply = "";
  let sawEvent = false;
  const processChunk = (chunk) => {
    const dataLines = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;
    const raw = dataLines.join("\n").trim();
    if (!raw || raw === "[DONE]") return;
    let ev;
    try {
      ev = JSON.parse(raw);
    } catch {
      return;
    }
    sawEvent = true;
    if (ev.type === "token") {
      reply += ev.text;
      onToken(reply);
    } else if (ev.type === "done") {
      reply = ev.text || reply;
      onToken(reply);
    } else if (ev.type === "error") {
      const err = new Error(ev.error || "The guide could not answer just now.");
      err.noFallback = true;
      throw err;
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";
    for (const chunk of chunks) processChunk(chunk);
  }
  buffer += decoder.decode().replace(/\r\n?/g, "\n");
  if (buffer.trim()) {
    for (const chunk of buffer.split("\n\n")) processChunk(chunk);
  }
  if (!sawEvent || !reply.trim()) return null;
  return reply;
}

async function chatRequest(messages, { stream, signal }) {
  const payload = { messages };
  if (window.CoveProviders) {
    payload.provider = window.CoveProviders.currentId();
    const apiKey = window.CoveProviders.keyForCurrent();
    if (apiKey) payload.apiKey = apiKey;
  }
  return fetch(stream ? "/api/chat" : "/api/chat?stream=0", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-cove-session": sessionId,
      accept: stream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(payload),
  });
}

async function readErrorMessage(res) {
  const type = res.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    const data = await res.json().catch(() => null);
    if (data && (data.error || data.hint)) return data.error || data.hint;
  } else {
    const text = (await res.text().catch(() => "")).trim();
    if (text) return text;
  }
  return `Chat failed (${res.status})`;
}

/* ---- Slash Commands ---- */
const SLASH_COMMANDS = [
  { cmd: "/toml", desc: "Open netlify.toml Studio & Linter", run: () => { window.CoveWorkbench?.openTool?.("toml"); document.getElementById("workbench")?.scrollIntoView({ behavior: "smooth" }); } },
  { cmd: "/redirects", desc: "Open Redirect & Rewrite Simulator", run: () => { window.CoveWorkbench?.openTool?.("redirects"); document.getElementById("workbench")?.scrollIntoView({ behavior: "smooth" }); } },
  { cmd: "/cli", desc: "Open Netlify CLI Command Forge", run: () => { window.CoveWorkbench?.openTool?.("cli"); document.getElementById("workbench")?.scrollIntoView({ behavior: "smooth" }); } },
  { cmd: "/status", desc: "Print live Cove telemetry in chat", run: () => {
    const p = els.statusProvider?.textContent || "unknown";
    const c = els.statusCli?.textContent || "unknown";
    const k = els.statusKnowledge?.textContent || "unknown";
    const a = document.getElementById("status-account")?.textContent || "not linked";
    document.querySelector(".chat-card")?.classList.add("is-chatting");
    addBubble("assistant", `### Cove Telemetry\n- **Provider**: \`${p}\`\n- **CLI**: \`${c}\`\n- **Knowledge**: ${k}\n- **Account**: ${a}`);
    setState("success", { speech: "Telemetry snapshot posted to chat." });
  } },
  { cmd: "/boop", desc: "Ping Cove diagnostics & tip", run: () => window.CoveMascot?.boop?.() },
  { cmd: "/theme", desc: "Toggle Warm Cream / Obsidian Dark mode", run: () => els.themeBtn?.click() },
  { cmd: "/clear", desc: "Start a fresh conversation", run: () => startNewConversation() },
];

function closeSlashMenu() {
  if (els.slashMenu) els.slashMenu.hidden = true;
}

function renderSlashMenu(filter = "") {
  if (!els.slashMenu) return;
  const q = filter.toLowerCase();
  const matches = SLASH_COMMANDS.filter((c) => c.cmd.includes(q) || c.desc.toLowerCase().includes(q));
  if (!matches.length) {
    closeSlashMenu();
    return;
  }
  state.slashIndex = Math.min(state.slashIndex, matches.length - 1);
  els.slashMenu.innerHTML = matches
    .map((item, idx) => `<button type="button" class="slash-item${idx === state.slashIndex ? " is-active" : ""}" role="option" data-slash-cmd="${escapeHtml(item.cmd)}"><code>${escapeHtml(item.cmd)}</code><span>${escapeHtml(item.desc)}</span></button>`)
    .join("");
  els.slashMenu.hidden = false;
}

function runSlashCommand(input) {
  const token = String(input || "").trim().split(/\s+/)[0].toLowerCase();
  const found = SLASH_COMMANDS.find((c) => c.cmd === token);
  if (!found) return false;
  els.prompt.value = "";
  autoGrowPrompt();
  closeSlashMenu();
  found.run();
  return true;
}

els.slashMenu?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-slash-cmd]");
  if (btn) runSlashCommand(btn.dataset.slashCmd);
});

els.slashTrigger?.addEventListener("click", () => {
  if (!els.slashMenu) return;
  if (els.slashMenu.hidden) {
    state.slashIndex = 0;
    renderSlashMenu("/");
    els.prompt?.focus();
  } else {
    closeSlashMenu();
  }
});

function autoGrowPrompt() {
  if (!els.prompt) return;
  els.prompt.style.height = "auto";
  els.prompt.style.height = `${Math.min(els.prompt.scrollHeight, 120)}px`;
}

async function sendQuestion(text) {
  const content = String(text || "").trim();
  if (!content || state.busy) return;
  if (content.startsWith("/") && runSlashCommand(content)) return;

  els.prompt.value = "";
  autoGrowPrompt();
  closeSlashMenu();
  if (els.followupRow) els.followupRow.hidden = true;
  document.querySelector(".chat-card")?.classList.add("is-chatting");
  state.messages.push({ role: "user", content });
  addBubble("user", content);
  const assistant = addBubble("assistant", "Thinking…", { streaming: true });
  assistant.body.innerHTML = `<span class="typing">Thinking</span>`;
  setBusy(true);
  setState("thinking", { speech: "Scanning official Netlify docs & composing answer…" });
  const controller = new AbortController();
  state.abortController = controller;
  let reply = "";
  try {
    let usedStream = false;
    try {
      const res = await chatRequest(state.messages, { stream: true, signal: controller.signal });
      if (!res.ok) {
        const err = new Error(await readErrorMessage(res));
        err.noFallback = res.status < 500 || res.status === 503;
        throw err;
      }
      const streamed = await readSseReply(res, (partial) => {
        if (!usedStream) {
          usedStream = true;
          setState("talking", { speech: "Streaming grounded response…" });
        }
        reply = partial;
        assistant.body.innerHTML = renderMarkdown(reply);
        scrollTranscript();
      });
      if (streamed) reply = streamed;
    } catch (err) {
      if (err?.name === "AbortError" || err?.noFallback) throw err;
      reply = "";
    }
    if (!reply.trim()) {
      const res = await chatRequest(state.messages, { stream: false, signal: controller.signal });
      const data = res.headers.get("content-type")?.includes("application/json")
        ? await res.json()
        : { error: await res.text() };
      if (!res.ok) throw new Error(data.error || `Chat failed (${res.status})`);
      reply = data.text || "";
      if (!reply.trim()) throw new Error(data.error || "The guide returned an empty answer.");
      setState("talking");
      assistant.body.innerHTML = renderMarkdown(reply);
      scrollTranscript();
    }
    state.messages.push({ role: "assistant", content: reply });
    const meta = assistant.li.querySelector(".bubble-meta");
    if (meta && !meta.querySelector(".bubble-copy")) {
      meta.insertAdjacentHTML("beforeend", `<button type="button" class="bubble-copy" data-copy-bubble="1" title="Copy answer">Copy</button>`);
    }
    renderFollowups(reply);
    if (window.CoveConversations) {
      window.CoveConversations.saveMessages(state.messages);
      window.CoveConversations.analyzeCurrent();
    }
  } catch (err) {
    if (err?.name === "AbortError") {
      if (reply.trim()) {
        state.messages.push({ role: "assistant", content: reply });
      } else {
        assistant.body.innerHTML = renderMarkdown("_Generation stopped._");
        if (state.messages.length && state.messages[state.messages.length - 1]?.role === "user") state.messages.pop();
      }
      setState("idle");
    } else {
      if (!reply.trim() && state.messages.length && state.messages[state.messages.length - 1]?.role === "user") {
        state.messages.pop();
      }
      assistant.body.innerHTML = renderMarkdown(`I hit a snag: ${err.message}`);
      setState("error", { speech: "Hit a snag — check your provider key or network." });
    }
  } finally {
    state.abortController = null;
    assistant.body.classList.remove("streaming");
    setBusy(false);
    if (reply.trim()) {
      const hasCode = /```/.test(reply);
      setState(hasCode ? "code" : "success", { speech: hasCode ? "Code snippet ready — click Copy on any block." : "Answer complete." });
    } else if (els.buoy?.dataset.mood !== "error") {
      setState("idle");
    }
    scrollTranscript();
  }
}

/* Expose helper for Workbench "Ask Cove" buttons */
window.CoveAsk = (question) => {
  document.querySelector(".chat-card")?.scrollIntoView({ behavior: "smooth", block: "center" });
  sendQuestion(question);
};

els.composer.addEventListener("submit", (e) => {
  e.preventDefault();
  sendQuestion(els.prompt.value);
});

els.prompt.addEventListener("input", () => {
  autoGrowPrompt();
  const val = els.prompt.value;
  if (val.startsWith("/") && !val.includes("\n") && !val.includes(" ")) {
    state.slashIndex = 0;
    renderSlashMenu(val);
  } else {
    closeSlashMenu();
  }
});

els.prompt.addEventListener("keydown", (e) => {
  if (els.slashMenu && !els.slashMenu.hidden) {
    const items = els.slashMenu.querySelectorAll(".slash-item");
    if (e.key === "ArrowDown") {
      e.preventDefault();
      state.slashIndex = (state.slashIndex + 1) % items.length;
      renderSlashMenu(els.prompt.value || "/");
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      state.slashIndex = (state.slashIndex - 1 + items.length) % items.length;
      renderSlashMenu(els.prompt.value || "/");
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeSlashMenu();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && items[state.slashIndex]) {
      e.preventDefault();
      runSlashCommand(items[state.slashIndex].dataset.slashCmd);
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.composer.requestSubmit();
  }
});

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    els.prompt?.focus();
    state.slashIndex = 0;
    renderSlashMenu("/");
  }
});

/* Optional Web Speech API voice input */
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRec && els.voiceBtn) {
  els.voiceBtn.hidden = false;
  let rec = null;
  let listening = false;
  els.voiceBtn.addEventListener("click", () => {
    if (listening && rec) {
      rec.stop();
      return;
    }
    rec = new SpeechRec();
    rec.lang = "en-US";
    rec.interimResults = false;
    listening = true;
    els.voiceBtn.classList.add("is-recording");
    setState("listening", { speech: "Listening to your microphone…" });
    rec.onresult = (ev) => {
      const transcript = ev.results?.[0]?.[0]?.transcript || "";
      if (transcript) {
        els.prompt.value = transcript;
        autoGrowPrompt();
        els.prompt.focus();
      }
    };
    rec.onend = () => {
      listening = false;
      els.voiceBtn.classList.remove("is-recording");
      setState("idle");
    };
    rec.onerror = () => {
      listening = false;
      els.voiceBtn.classList.remove("is-recording");
      setState("idle");
    };
    rec.start();
  });
}

document.getElementById("chips").addEventListener("click", (e) => {
  const button = e.target.closest("button[data-q]");
  if (button) sendQuestion(button.dataset.q);
});

els.refresh.addEventListener("click", async () => {
  els.refresh.disabled = true;
  els.hint.textContent = "Fetching netlify.ai and official docs…";
  setState("thinking", { speech: "Refreshing official Netlify documentation cache…" });
  try {
    const result = await api("/api/knowledge/refresh", { method: "POST", body: "{}" });
    els.hint.textContent = `Updated ${result.okCount} official sources.`;
    setState("success", { speech: `Updated ${result.okCount} official sources.` });
    await loadStatus();
  } catch (err) {
    els.hint.textContent = err.message;
    setState("error");
  } finally {
    els.refresh.disabled = false;
  }
});

els.research.addEventListener("click", async () => {
  els.research.disabled = true;
  setState("thinking", { speech: "Researching official sources and running read-only CLI checks…" });
  els.hint.textContent = "Researching official sources and running read-only CLI tests…";
  let ok = false;
  try {
    const result = await api("/api/research", { method: "POST", body: "{}" });
    els.hint.textContent = result.summary || "Guide updated.";
    await loadStatus();
    ok = true;
  } catch (err) {
    els.hint.textContent = err.message;
  } finally {
    els.research.disabled = false;
    setState(ok ? "success" : "error");
  }
});

els.share.addEventListener("click", async () => {
  const url = new URL("/netlify-ai.md", window.location.origin).href;
  try {
    await navigator.clipboard.writeText(url);
    els.hint.textContent = `Copied ${url}`;
    window.CoveMascot?.playTone?.("success");
    window.CoveMascot?.say?.("Copied shareable /netlify-ai.md link to clipboard.");
  } catch {
    els.hint.textContent = `Share this guide: ${url}`;
    window.prompt("Copy this knowledge URL", url);
  }
});

const WELCOME = "Hi, I’m Cove — a fan-made community guide for the Netlify CLI and platform. I’m not an official Netlify product. Ask me about deploys, functions, Netlify Server, or type / to open my in-browser config tools.";

function isWelcome(message) {
  return message?.role === "assistant" && String(message.content || "").startsWith("Hi, I’m Cove");
}

function startNewConversation() {
  if (state.busy) return;
  state.messages = [];
  document.querySelector(".chat-card")?.classList.remove("is-chatting");
  if (els.followupRow) els.followupRow.hidden = true;
  els.transcript.innerHTML = "";
  addBubble("assistant", WELCOME);
  if (window.CoveConversations?.clearCurrent) window.CoveConversations.clearCurrent();
  else window.CoveConversations?.create([]);
}

function loadConversation(item) {
  if (state.busy) return;
  const messages = Array.isArray(item?.messages) ? item.messages : [];
  state.messages = messages.filter((m) => !isWelcome(m));
  els.transcript.innerHTML = "";
  const card = document.querySelector(".chat-card");
  const hasUser = state.messages.some((m) => m.role === "user");
  card?.classList.toggle("is-chatting", hasUser);
  if (els.followupRow) els.followupRow.hidden = true;
  if (!messages.length) {
    addBubble("assistant", WELCOME);
    return;
  }
  for (const message of messages) addBubble(message.role, message.content);
  scrollTranscript();
}

if (window.CoveConversations) {
  window.CoveConversations.bind({
    api,
    onNew: startNewConversation,
    onLoad: loadConversation,
  });
  const current = window.CoveConversations.current();
  if (current?.messages?.some((m) => m.role === "user")) loadConversation(current);
  else addBubble("assistant", WELCOME);
} else {
  addBubble("assistant", WELCOME);
}
loadStatus();
