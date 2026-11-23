/**
 * Saved conversations, search, tag filters, and the drawer UI.
 * Transcripts live in localStorage on this browser. Export is a download.
 */
const CONVO_KEY = "cove-conversations-v1";
const CONVO_TAGS = [
  "Deploys", "Functions", "Server", "Redirects", "Forms",
  "Blobs", "DNS/Domains", "CLI", "Billing", "Debugging",
];

const convoState = {
  items: [],
  currentId: null,
  filterTag: "All",
  query: "",
  hooks: null,
};

function loadStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(CONVO_KEY) || "null");
    if (raw && Array.isArray(raw.items)) {
      convoState.items = raw.items;
      convoState.currentId = raw.currentId || raw.items[0]?.id || null;
      return;
    }
  } catch {
    /* start empty */
  }
  convoState.items = [];
  convoState.currentId = null;
}

function persistStore() {
  localStorage.setItem(CONVO_KEY, JSON.stringify({
    currentId: convoState.currentId,
    items: convoState.items,
  }));
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID().replaceAll("-", "") : `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function previewOf(messages) {
  const user = (messages || []).find((m) => m.role === "user");
  return String(user?.content || "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function currentConvo() {
  return convoState.items.find((c) => c.id === convoState.currentId) || null;
}

function createConversation(seedMessages = []) {
  const item = {
    id: uid(),
    title: "New conversation",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    messages: seedMessages,
    tags: [],
    tagSource: null,
  };
  convoState.items.unshift(item);
  convoState.currentId = item.id;
  persistStore();
  return item;
}

function saveMessages(messages) {
  let item = currentConvo();
  const cloned = (Array.isArray(messages) ? messages : []).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || ""),
  }));
  if (!item) item = createConversation(cloned);
  else item.messages = cloned;
  item.updatedAt = nowIso();
  if (item.title === "New conversation") {
    const first = cloned.find((m) => m.role === "user" && m.content.trim());
    if (first) item.title = first.content.replace(/\s+/g, " ").trim().slice(0, 56);
  }
  persistStore();
  renderConversationList();
  return item;
}

const analyzeSeq = new WeakMap();

async function analyzeCurrent() {
  const item = currentConvo();
  const hooks = convoState.hooks;
  if (!item || !hooks?.api) return item;
  const usable = (item.messages || []).filter((m) => m.role === "user" || (m.role === "assistant" && !String(m.content).startsWith("Hi, I’m Cove")));
  if (!usable.length) return item;
  const seq = (analyzeSeq.get(item) || 0) + 1;
  analyzeSeq.set(item, seq);
  try {
    const result = await hooks.api("/api/conversations/analyze", {
      method: "POST",
      body: JSON.stringify({ messages: usable.slice(-12) }),
    });
    if (analyzeSeq.get(item) !== seq) return item;
    if (!convoState.items.includes(item)) return item;
    if (result?.title) item.title = result.title;
    if (Array.isArray(result?.tags)) item.tags = result.tags;
    item.tagSource = result?.source || "keywords";
    item.updatedAt = nowIso();
    persistStore();
    renderConversationList();
    renderTagFilters();
  } catch {
    /* keep keyword-less or previous tags */
  }
  return item;
}

function formatWhen(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET";
}

function filteredItems() {
  const q = convoState.query.trim().toLowerCase();
  return convoState.items.filter((item) => {
    if (convoState.filterTag !== "All" && !(item.tags || []).includes(convoState.filterTag)) return false;
    if (!q) return true;
    const hay = `${item.title} ${(item.tags || []).join(" ")} ${previewOf(item.messages)}`.toLowerCase();
    return hay.includes(q);
  });
}

function renderTagFilters() {
  const root = document.getElementById("tag-filters");
  if (!root) return;
  const used = new Set();
  convoState.items.forEach((item) => (item.tags || []).forEach((t) => used.add(t)));
  const tags = ["All", ...CONVO_TAGS.filter((t) => used.has(t) || t === convoState.filterTag)];
  root.innerHTML = tags.map((tag) => {
    const on = tag === convoState.filterTag;
    const safeTag = escapeText(tag);
    return `<button type="button" class="tag-chip${on ? " is-active" : ""}" data-tag="${safeTag}" aria-pressed="${on}">${safeTag}</button>`;
  }).join("");
}

function renderConversationList() {
  const root = document.getElementById("conversation-list");
  const empty = document.getElementById("conversation-empty");
  if (!root) return;
  const items = filteredItems();
  if (empty) empty.hidden = items.length > 0;
  root.innerHTML = items.map((item) => {
    const active = item.id === convoState.currentId;
    const safeId = escapeText(item.id);
    const tags = (item.tags || []).map((t) => `<span class="mini-tag">${escapeText(t)}</span>`).join("");
    const preview = previewOf(item.messages);
    return `<li>
      <button type="button" class="convo-item${active ? " is-active" : ""}" data-id="${safeId}">
        <span class="convo-title">${escapeText(item.title || "Untitled")}</span>
        <span class="convo-meta">${formatWhen(item.updatedAt)}</span>
        ${preview ? `<span class="convo-preview">${escapeText(preview)}</span>` : ""}
        ${tags ? `<span class="convo-tags">${tags}</span>` : ""}
      </button>
      <button type="button" class="convo-delete" data-delete="${safeId}" aria-label="Delete conversation">Delete</button>
    </li>`;
  }).join("");
}

function escapeText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setTabs(which) {
  const chat = document.getElementById("tab-chat");
  const conv = document.getElementById("tab-conversations");
  if (chat) {
    chat.classList.toggle("is-active", which === "chat");
    chat.setAttribute("aria-selected", which === "chat" ? "true" : "false");
  }
  if (conv) {
    conv.classList.toggle("is-active", which === "conversations");
    conv.setAttribute("aria-selected", which === "conversations" ? "true" : "false");
  }
}

function openDrawer() {
  window.CoveAccount?.closeDrawer?.();
  const drawer = document.getElementById("conversations-drawer");
  const backdrop = document.getElementById("drawer-backdrop");
  if (drawer) {
    drawer.hidden = false;
    drawer.classList.add("is-open");
  }
  if (backdrop) {
    backdrop.hidden = false;
    backdrop.classList.add("is-open");
  }
  document.body.classList.add("drawer-open");
  setTabs("conversations");
  renderTagFilters();
  renderConversationList();
  document.getElementById("conversation-search")?.focus();
}

function closeDrawer() {
  const drawer = document.getElementById("conversations-drawer");
  const backdrop = document.getElementById("drawer-backdrop");
  if (drawer) {
    drawer.classList.remove("is-open");
    drawer.hidden = true;
  }
  const accountOpen = document.getElementById("account-drawer") && !document.getElementById("account-drawer").hidden;
  if (backdrop && !accountOpen) {
    backdrop.classList.remove("is-open");
    backdrop.hidden = true;
  }
  if (!accountOpen) document.body.classList.remove("drawer-open");
  setTabs("chat");
}

function download(filename, text, type = "application/json") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportCurrent() {
  const item = currentConvo();
  if (!item) return;
  const md = [`# ${item.title}`, "", `Updated ${item.updatedAt}`, item.tags?.length ? `Tags: ${item.tags.join(", ")}` : "", "", ...(item.messages || []).map((m) => `**${m.role === "user" ? "You" : "Cove"}**\n\n${m.content}`)].filter((l, i, arr) => l !== "" || arr[i - 1] !== "").join("\n");
  const safe = (item.title || "conversation").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  download(`cove-${safe || "conversation"}.md`, md, "text/markdown");
}

function exportAll() {
  download(`cove-conversations.json`, JSON.stringify({ exportedAt: nowIso(), items: convoState.items }, null, 2));
}

function bindDrawer() {
  document.getElementById("open-conversations")?.addEventListener("click", openDrawer);
  document.getElementById("tab-conversations")?.addEventListener("click", openDrawer);
  document.getElementById("tab-chat")?.addEventListener("click", closeDrawer);
  document.getElementById("drawer-backdrop")?.addEventListener("click", closeDrawer);
  document.getElementById("close-conversations")?.addEventListener("click", closeDrawer);
  document.getElementById("new-conversation")?.addEventListener("click", () => {
    convoState.hooks?.onNew();
    closeDrawer();
  });
  document.getElementById("export-conversation")?.addEventListener("click", exportCurrent);
  document.getElementById("export-all-conversations")?.addEventListener("click", exportAll);
  document.getElementById("conversation-search")?.addEventListener("input", (e) => {
    convoState.query = e.target.value || "";
    renderConversationList();
  });
  document.getElementById("tag-filters")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tag]");
    if (!btn) return;
    convoState.filterTag = btn.dataset.tag;
    renderTagFilters();
    renderConversationList();
  });
  document.getElementById("conversation-list")?.addEventListener("click", (e) => {
    const del = e.target.closest("[data-delete]");
    if (del) {
      const id = del.dataset.delete;
      convoState.items = convoState.items.filter((c) => c.id !== id);
      if (convoState.currentId === id) {
        convoState.currentId = convoState.items[0]?.id || null;
        if (convoState.currentId) convoState.hooks?.onLoad(currentConvo());
        else convoState.hooks?.onNew();
      }
      persistStore();
      renderTagFilters();
      renderConversationList();
      return;
    }
    const pick = e.target.closest("[data-id]");
    if (pick) {
      const item = convoState.items.find((c) => c.id === pick.dataset.id);
      if (item) {
        convoState.currentId = item.id;
        persistStore();
        convoState.hooks?.onLoad(item);
        closeDrawer();
      }
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
  });
}

window.CoveConversations = {
  tags: CONVO_TAGS,
  loadStore,
  current: currentConvo,
  create: createConversation,
  saveMessages,
  analyzeCurrent,
  openDrawer,
  closeDrawer,
  bind(hooks) {
    convoState.hooks = hooks;
    loadStore();
    bindDrawer();
    renderTagFilters();
    renderConversationList();
  },
};
