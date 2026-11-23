(() => {
  const KEYS = "cove-provider-keys";
  const PICK = "cove-provider-id";
  const VERIFIER = "cove-openrouter-verifier";
  const OR_STATE = "cove-openrouter-state";

  const sessionId = (() => {
    const key = "cove-session";
    let id = localStorage.getItem(key);
    if (!id || !/^[a-zA-Z0-9_-]{8,80}$/.test(id)) {
      id = crypto.randomUUID().replaceAll("-", "");
      localStorage.setItem(key, id);
    }
    return id;
  })();

  function loadKeys() {
    try {
      return JSON.parse(sessionStorage.getItem(KEYS) || "{}");
    } catch {
      return {};
    }
  }

  function saveKeys(map) {
    sessionStorage.setItem(KEYS, JSON.stringify(map));
  }

  function currentId() {
    return localStorage.getItem(PICK) || "agy";
  }

  function setCurrentId(id) {
    localStorage.setItem(PICK, id);
  }

  function keyFor(id) {
    const keys = loadKeys();
    return keys[id] || "";
  }

  function setKey(id, value) {
    const keys = loadKeys();
    if (value) keys[id] = value;
    else delete keys[id];
    saveKeys(keys);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function b64url(bytes) {
    let str = btoa(String.fromCharCode(...new Uint8Array(bytes)));
    return str.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  }

  async function pkce() {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const verifier = b64url(raw);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return { verifier, challenge: b64url(digest) };
  }

  const panel = document.getElementById("providers-panel");
  const status = document.getElementById("status-provider");
  let catalog = null;
  let lastError = "";

  function providerLabel(id) {
    const local = catalog?.local?.find((p) => p.id === id);
    const cloud = catalog?.cloud?.find((p) => p.id === id);
    return local?.label || cloud?.label || id;
  }

  function render() {
    if (!panel || !catalog) return;
    const selected = currentId();
    const localCards = (catalog.local || []).map((item) => {
      const checked = selected === item.id ? "checked" : "";
      return `<label class="provider-card">
        <input type="radio" name="cove-provider" value="${escapeHtml(item.id)}" ${checked} />
        <span>
          <strong>${escapeHtml(item.label)}</strong>
          <span class="provider-meta">${escapeHtml(item.version || "")}</span>
          <span class="account-copy">${escapeHtml(item.detail)}</span>
        </span>
      </label>`;
    }).join("") || `<p class="account-copy">No runnable local CLIs were detected on this host.</p>`;

    const cloudCards = (catalog.cloud || []).map((item) => {
      const checked = selected === item.id ? "checked" : "";
      const hasKey = Boolean(keyFor(item.id));
      const keyBlock = item.auth === "oauth-pkce"
        ? `<div class="account-actions">
             <button type="button" class="btn btn-primary" data-openrouter="1">${hasKey ? "Reconnect OpenRouter" : "Sign in with OpenRouter"}</button>
             ${hasKey ? `<button type="button" class="btn btn-muted" data-clear-key="${escapeHtml(item.id)}">Clear key</button>` : ""}
           </div>
           <p class="provider-meta">${hasKey ? "OpenRouter key stored in this tab’s session only." : "Uses official OpenRouter PKCE OAuth."}</p>`
        : `<form class="token-form" data-key-form="${escapeHtml(item.id)}" autocomplete="off">
             <label class="sr-only" for="key-${escapeHtml(item.id)}">${escapeHtml(item.label)} API key</label>
             <input id="key-${escapeHtml(item.id)}" type="password" autocomplete="off" spellcheck="false" placeholder="${hasKey ? "Key saved in this tab — paste to replace" : "API key"}" />
             <button type="submit" class="btn btn-muted">${hasKey ? "Replace key" : "Save key"}</button>
             ${hasKey ? `<button type="button" class="btn btn-muted" data-clear-key="${escapeHtml(item.id)}">Clear</button>` : ""}
           </form>
           ${item.keyUrl ? `<p class="provider-meta"><a href="${escapeHtml(item.keyUrl)}" rel="noopener" target="_blank">Get an API key</a></p>` : ""}`;
      return `<div class="provider-card provider-card-cloud">
        <label class="provider-choice">
          <input type="radio" name="cove-provider" value="${escapeHtml(item.id)}" ${checked} />
          <span>
            <strong>${escapeHtml(item.label)}</strong>
            <span class="account-copy">${escapeHtml(item.authLabel)}</span>
          </span>
        </label>
        <div class="provider-controls">
          ${item.docs ? `<p class="provider-meta"><a href="${escapeHtml(item.docs)}" rel="noopener" target="_blank">Docs</a></p>` : ""}
          ${keyBlock}
        </div>
      </div>`;
    }).join("");

    const skipped = (catalog.skipped || []).map((item) => `<li><strong>${escapeHtml(item.id)}</strong> — ${escapeHtml(item.reason)}</li>`).join("");
    const errorHtml = lastError ? `<p class="account-error">${escapeHtml(lastError)}</p>` : "";

    panel.innerHTML = `
      ${errorHtml}
      <p class="account-lead">Choose who answers. Local CLIs run on the machine hosting this session, sandboxed like agy. Cloud providers use a key kept in this browser tab only — never written to disk or application logs. Cove does not show a sign-in button unless that provider actually offers third-party OAuth for model inference.</p>
      <section class="account-card">
        <p class="eyebrow">This machine</p>
        <h3>Local CLIs</h3>
        <div class="provider-list">${localCards}</div>
      </section>
      <section class="account-card">
        <p class="eyebrow">Your credentials</p>
        <h3>Cloud providers</h3>
        <div class="provider-list">${cloudCards}</div>
      </section>
      <section class="account-card">
        <p class="eyebrow">Not offered</p>
        <h3>Detected but not runnable here</h3>
        <ul class="skip-list">${skipped}</ul>
      </section>`;
    syncStatus();
  }

  function syncStatus() {
    if (!status || !catalog) return false;
    const id = currentId();
    const label = providerLabel(id);
    const needsKey = (catalog.cloud || []).some((item) => item.id === id);
    const ready = !needsKey || Boolean(keyFor(id));
    status.textContent = ready ? label : `${label} (key needed)`;
    return true;
  }

  async function startOpenRouter() {
    lastError = "";
    if (!window.crypto?.subtle) {
      lastError = "OpenRouter PKCE requires a secure context (HTTPS or localhost).";
      render();
      return;
    }
    try {
      const { verifier, challenge } = await pkce();
      const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
      sessionStorage.setItem(VERIFIER, verifier);
      sessionStorage.setItem(OR_STATE, state);
      const callback = `${window.location.origin}/`;
      const url = `https://openrouter.ai/auth?${new URLSearchParams({
        callback_url: callback,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        key_label: "Cove",
      }).toString()}`;
      window.location.href = url;
    } catch (err) {
      lastError = err.message || "Could not start OpenRouter PKCE flow.";
      render();
    }
  }

  async function finishOpenRouter() {
    const params = new URLSearchParams(window.location.search);
    const verifier = sessionStorage.getItem(VERIFIER);
    const expectedState = sessionStorage.getItem(OR_STATE);
    const returnedError = params.get("error");
    if (returnedError && verifier) {
      sessionStorage.removeItem(VERIFIER);
      sessionStorage.removeItem(OR_STATE);
      history.replaceState({}, "", window.location.pathname);
      lastError = `OpenRouter sign-in did not complete (${returnedError}).`;
      return false;
    }
    const code = params.get("code");
    if (!code || !verifier) return false;
    const returnedState = params.get("state");
    if (expectedState && returnedState && returnedState !== expectedState) {
      sessionStorage.removeItem(VERIFIER);
      sessionStorage.removeItem(OR_STATE);
      history.replaceState({}, "", window.location.pathname);
      lastError = "OpenRouter state mismatch. Please try signing in again.";
      return false;
    }
    try {
      const res = await fetch("https://openrouter.ai/api/v1/auth/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
      });
      const data = await res.json().catch(() => ({}));
      sessionStorage.removeItem(VERIFIER);
      sessionStorage.removeItem(OR_STATE);
      history.replaceState({}, "", window.location.pathname);
      if (!res.ok || !data.key) throw new Error(data.error?.message || data.error || "OpenRouter did not return a key.");
      setKey("openrouter", data.key);
      setCurrentId("openrouter");
      lastError = "";
      return true;
    } catch (err) {
      sessionStorage.removeItem(VERIFIER);
      sessionStorage.removeItem(OR_STATE);
      history.replaceState({}, "", window.location.pathname);
      lastError = err.message || "OpenRouter key exchange failed.";
      return false;
    }
  }

  panel?.addEventListener("change", (e) => {
    const radio = e.target.closest('input[name="cove-provider"]');
    if (radio) {
      setCurrentId(radio.value);
      syncStatus();
    }
  });

  panel?.addEventListener("click", (e) => {
    if (e.target.closest("[data-openrouter]")) startOpenRouter();
    const clear = e.target.closest("[data-clear-key]");
    if (clear) {
      setKey(clear.dataset.clearKey, "");
      render();
    }
  });

  panel?.addEventListener("submit", (e) => {
    const form = e.target.closest("[data-key-form]");
    if (!form) return;
    e.preventDefault();
    const id = form.dataset.keyForm;
    const input = form.querySelector("input");
    const value = input?.value?.trim() || "";
    if (input) input.value = "";
    if (value) {
      setKey(id, value);
      setCurrentId(id);
    }
    render();
  });

  async function load() {
    try {
      const res = await fetch("/api/providers", { headers: { "x-cove-session": sessionId } });
      if (!res.ok) throw new Error(`Could not load providers (${res.status})`);
      catalog = await res.json();
      if (!localStorage.getItem(PICK) && catalog.defaultId) setCurrentId(catalog.defaultId);
      await finishOpenRouter();
      render();
    } catch (err) {
      if (status) status.textContent = providerLabel(currentId());
      if (panel) panel.innerHTML = `<p class="account-error">${escapeHtml(err.message)}</p>`;
    }
  }

  window.CoveProviders = {
    currentId,
    keyForCurrent() {
      const id = currentId();
      return keyFor(id) || "";
    },
    syncStatus,
    load,
  };

  load();
})();
