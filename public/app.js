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
};

const els = {
  transcript: document.getElementById("transcript"),
  composer: document.getElementById("composer"),
  prompt: document.getElementById("prompt"),
  send: document.getElementById("send"),
  buoy: document.getElementById("buoy"),
  statusProvider: document.getElementById("status-provider"),
  statusCli: document.getElementById("status-cli"),
  statusKnowledge: document.getElementById("status-knowledge"),
  refresh: document.getElementById("refresh-knowledge"),
  research: document.getElementById("run-research"),
  share: document.getElementById("share-guide"),
  hint: document.getElementById("job-hint"),
};

function setState(mode) {
  if (window.CoveMascot) {
    window.CoveMascot.setMood(mode);
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
  let text = String(raw).replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
    const i = fences.length;
    fences.push(`<pre><code class="lang-${escapeHtml(lang || "text")}">${escapeHtml(code.trimEnd())}</code></pre>`);
    return `\u0000FENCE${i}\u0000`;
  });
  text = escapeHtml(text);
  text = text.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  text = text.replace(/^## (.+)$/gm, "<h3>$1</h3>");
  text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|\n)- (.+)/g, "$1<li>$2</li>");
  text = text.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
  text = text.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" rel="noopener" target="_blank">$1</a>');
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
  li.innerHTML = `<div class="who">${role === "user" ? "You" : "Cove"}</div><div class="body"></div>`;
  const body = li.querySelector(".body");
  body.innerHTML = role === "assistant" ? renderMarkdown(content || "") : escapeHtml(content || "").replaceAll("\n", "<br>");
  if (streaming) body.classList.add("streaming");
  if (role === "assistant" && String(content || "").startsWith("Hi, I’m Cove")) li.classList.add("welcome");
  els.transcript.appendChild(li);
  scrollTranscript();
  return { li, body };
}

function setBusy(busy) {
  state.busy = busy;
  els.send.disabled = busy;
  els.prompt.disabled = busy;
  document.body.dataset.coveBusy = busy ? "true" : "false";
}

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
    const message = typeof data === "object" ? data.error : data;
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
    els.statusProvider.textContent = status.provider.available
      ? status.provider.label
      : status.provider.reason || "unavailable";
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
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";
    for (const chunk of chunks) {
      const line = chunk.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const ev = JSON.parse(line.slice(5).trim());
      sawEvent = true;
      if (ev.type === "token") {
        reply += ev.text;
        onToken(reply);
      } else if (ev.type === "done") {
        reply = ev.text || reply;
        onToken(reply);
      } else if (ev.type === "error") {
        throw new Error(ev.error || "The guide could not answer just now.");
      }
    }
  }
  if (!sawEvent || !reply.trim()) return null;
  return reply;
}

async function chatRequest(messages, { stream }) {
  return fetch(stream ? "/api/chat" : "/api/chat?stream=0", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cove-session": sessionId,
      accept: stream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify({ messages }),
  });
}

async function sendQuestion(text) {
  const content = String(text || "").trim();
  if (!content || state.busy) return;
  els.prompt.value = "";
  document.querySelector(".chat-card")?.classList.add("is-chatting");
  state.messages.push({ role: "user", content });
  addBubble("user", content);
  const assistant = addBubble("assistant", "Thinking…", { streaming: true });
  assistant.body.innerHTML = `<span class="typing">Thinking</span>`;
  setBusy(true);
  setState("thinking");
  let reply = "";
  try {
    let usedStream = false;
    try {
      const res = await chatRequest(state.messages, { stream: true });
      if (res.ok) {
        const streamed = await readSseReply(res, (partial) => {
          if (!usedStream) {
            usedStream = true;
            setState("talking");
          }
          reply = partial;
          assistant.body.innerHTML = renderMarkdown(reply);
          scrollTranscript();
        });
        if (streamed) reply = streamed;
      }
    } catch {
      reply = "";
    }
    if (!reply.trim()) {
      const res = await chatRequest(state.messages, { stream: false });
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
    if (window.CoveConversations) {
      window.CoveConversations.saveMessages(state.messages);
      window.CoveConversations.analyzeCurrent();
    }
  } catch (err) {
    assistant.body.innerHTML = renderMarkdown(`I hit a snag: ${err.message}`);
    setState("error");
  } finally {
    setBusy(false);
    if (reply.trim()) {
      setState(/```/.test(reply) ? "code" : "success");
    } else if (els.buoy?.dataset.mood !== "error") {
      setState("idle");
    }
    scrollTranscript();
  }
}

els.composer.addEventListener("submit", (e) => {
  e.preventDefault();
  sendQuestion(els.prompt.value);
});

els.prompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.composer.requestSubmit();
  }
});

document.getElementById("chips").addEventListener("click", (e) => {
  const button = e.target.closest("button[data-q]");
  if (button) sendQuestion(button.dataset.q);
});

els.refresh.addEventListener("click", async () => {
  els.refresh.disabled = true;
  els.hint.textContent = "Fetching netlify.ai and official docs…";
  try {
    const result = await api("/api/knowledge/refresh", { method: "POST", body: "{}" });
    els.hint.textContent = `Updated ${result.okCount} official sources.`;
    await loadStatus();
  } catch (err) {
    els.hint.textContent = err.message;
  } finally {
    els.refresh.disabled = false;
  }
});

els.research.addEventListener("click", async () => {
  els.research.disabled = true;
  setState("thinking");
  els.hint.textContent = "Researching official sources and running read-only CLI tests…";
  try {
    const result = await api("/api/research", { method: "POST", body: "{}" });
    els.hint.textContent = result.summary || "Guide updated.";
    await loadStatus();
  } catch (err) {
    els.hint.textContent = err.message;
  } finally {
    els.research.disabled = false;
    setState("idle");
  }
});

els.share.addEventListener("click", async () => {
  const url = new URL("/netlify-ai.md", window.location.origin).href;
  try {
    await navigator.clipboard.writeText(url);
    els.hint.textContent = `Copied ${url}`;
  } catch {
    els.hint.textContent = `Share this guide: ${url}`;
    window.prompt("Copy this knowledge URL", url);
  }
});

const WELCOME = "Hi, I’m Cove — a fan-made community guide for the Netlify CLI and platform. I’m not an official Netlify product. Ask me about deploys, functions, Netlify Server, or how to share a dev link before you go live.";

function isWelcome(message) {
  return message?.role === "assistant" && String(message.content || "").startsWith("Hi, I’m Cove");
}

function startNewConversation() {
  state.messages = [];
  document.querySelector(".chat-card")?.classList.remove("is-chatting");
  els.transcript.innerHTML = "";
  addBubble("assistant", WELCOME);
  window.CoveConversations?.create([]);
}

function loadConversation(item) {
  const messages = Array.isArray(item?.messages) ? item.messages : [];
  state.messages = messages.filter((m) => !isWelcome(m));
  els.transcript.innerHTML = "";
  const card = document.querySelector(".chat-card");
  const hasUser = state.messages.some((m) => m.role === "user");
  card?.classList.toggle("is-chatting", hasUser);
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
