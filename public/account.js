(() => {
  const sessionId = (() => {
    const key = "cove-session";
    let id = localStorage.getItem(key);
    if (!id || !/^[a-zA-Z0-9_-]{8,80}$/.test(id)) {
      id = crypto.randomUUID().replaceAll("-", "");
      localStorage.setItem(key, id);
    }
    return id;
  })();

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
      const message = typeof data === "object" ? data.error || data.hint : data;
      const err = new Error(message || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  const els = {
    drawer: document.getElementById("account-drawer"),
    backdrop: document.getElementById("drawer-backdrop"),
    status: document.getElementById("status-account"),
    panel: document.getElementById("account-panel"),
  };

  let pollTimer = 0;
  let latest = null;

  function setBackdrop() {
    const convOpen = !document.getElementById("conversations-drawer")?.hidden;
    const acctOpen = !els.drawer?.hidden;
    const open = Boolean(convOpen || acctOpen);
    if (els.backdrop) {
      els.backdrop.hidden = !open;
      els.backdrop.classList.toggle("is-open", open);
    }
    document.body.classList.toggle("drawer-open", open);
  }

  function openDrawer() {
    window.CoveConversations?.closeDrawer?.();
    if (!els.drawer) return;
    els.drawer.hidden = false;
    els.drawer.classList.add("is-open");
    setBackdrop();
    refresh();
  }

  function closeDrawer() {
    if (!els.drawer) return;
    els.drawer.classList.remove("is-open");
    els.drawer.hidden = true;
    setBackdrop();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function statusLabel(data) {
    if (!data?.linked) return "not linked";
    const n = data.sites?.length || 0;
    const name = data.user?.name || data.user?.email || "linked";
    return n ? `${name} · ${n} site${n === 1 ? "" : "s"}` : name;
  }

  function siteRows(sites) {
    if (!sites?.length) return `<p class="account-empty">No sites came back for this account.</p>`;
    return `<ol class="site-list">${sites
      .map((site) => {
        const state = site.deploy?.state || "unknown";
        const when = site.deploy?.publishedAt
          ? new Date(site.deploy.publishedAt).toLocaleString("en-US", {
              timeZone: "America/New_York",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            }) + " ET"
          : "";
        const url = site.url
          ? `<a href="${escapeHtml(site.url)}" rel="noopener" target="_blank">${escapeHtml(site.url.replace(/^https?:\/\//, ""))}</a>`
          : "";
        return `<li class="site-row">
          <div>
            <strong>${escapeHtml(site.name)}</strong>
            <div class="site-meta">${url}</div>
          </div>
          <span class="deploy-pill" data-state="${escapeHtml(state)}">${escapeHtml(state)}${when ? ` · ${escapeHtml(when)}` : ""}</span>
        </li>`;
      })
      .join("")}</ol>`;
  }

  function render(data, extra = "") {
    latest = data;
    if (data && (!data.redirectUri || /localhost|127\.0\.0\.1/.test(data.redirectUri)) && window.location.origin.includes("netlify.live")) {
      data = { ...data, redirectUri: `${window.location.origin}/api/netlify/oauth/callback` };
    }
    if (els.status) els.status.textContent = statusLabel(data);
    if (!els.panel) return;

    if (data?.linked) {
      const who = [data.user?.name, data.user?.email].filter(Boolean).join(" · ") || "Linked account";
      els.panel.innerHTML = `
        <div class="account-card is-linked">
          <p class="eyebrow">Linked read-only</p>
          <h3>${escapeHtml(who)}</h3>
          <p class="account-copy">Cove can see sites and deploy status in this session to answer account-specific questions. It cannot deploy, change DNS, or touch billing.</p>
          <div class="account-actions">
            <button type="button" class="btn btn-muted" id="refresh-sites">Refresh sites</button>
            <button type="button" class="btn btn-muted" id="disconnect-netlify">Disconnect</button>
          </div>
        </div>
        ${siteRows(data.sites)}
        ${extra}`;
      return;
    }

    const oauth = data?.oauthConfigured
      ? `<button type="button" class="btn btn-primary" id="start-oauth">Connect with Netlify</button>
         <p class="account-copy">Uses a Netlify OAuth application registered by the host. You'll approve access on app.netlify.com.</p>`
      : `<p class="account-copy">Web OAuth is not configured on this host yet. The operator needs to register an application at
         <a href="https://app.netlify.com/user/applications" rel="noopener" target="_blank">app.netlify.com → User settings → Applications</a>
         and set <code>NETLIFY_OAUTH_CLIENT_ID</code> and <code>NETLIFY_OAUTH_CLIENT_SECRET</code>.
         Redirect URI: <code>${escapeHtml(data?.redirectUri || "/api/netlify/oauth/callback")}</code>.</p>`;

    els.panel.innerHTML = `
      <p class="account-lead">Link a Netlify account so Cove can answer questions about your sites and deploys. Access is read-only. Tokens stay in this session on the machine hosting Cove. They are never written to the browser, application logs, or the shareable guide.</p>

      <section class="account-card">
        <p class="eyebrow">Option 1</p>
        <h3>Netlify CLI ticket</h3>
        <p class="account-copy">Same flow as <code>netlify login --request</code>. Approve a URL, and Cove keeps the token in this session only. It will not write to the host CLI keychain. You can also run the commands yourself:</p>
        <pre><code>netlify login
netlify login --request "Cove read-only site access" --json</code></pre>
        <div class="account-actions">
          <button type="button" class="btn btn-primary" id="start-ticket">Start a login ticket</button>
        </div>
        <div id="ticket-status"></div>
      </section>

      <section class="account-card">
        <p class="eyebrow">Option 2</p>
        <h3>Web OAuth</h3>
        ${oauth}
      </section>

      <section class="account-card">
        <p class="eyebrow">Option 3</p>
        <h3>Personal access token</h3>
        <p class="account-copy">Create a token at <a href="https://app.netlify.com/user/applications#personal-access-tokens" rel="noopener" target="_blank">User settings → Applications</a>. Paste it here. It never leaves this session and is never logged.</p>
        <form id="token-form" class="token-form" autocomplete="off">
          <label class="sr-only" for="netlify-token">Netlify personal access token</label>
          <input id="netlify-token" name="token" type="password" autocomplete="off" spellcheck="false" placeholder="Personal access token" />
          <button type="submit" class="btn btn-muted">Link token</button>
        </form>
      </section>
      ${extra}`;
  }

  function showError(message) {
    const host = els.panel?.querySelector(".account-error") || document.createElement("p");
    host.className = "account-error";
    host.textContent = message;
    els.panel?.prepend(host);
  }

  async function refresh() {
    try {
      const data = await api("/api/netlify/status");
      render(data);
    } catch (err) {
      if (els.status) els.status.textContent = "unreachable";
      if (els.panel) els.panel.innerHTML = `<p class="account-error">${escapeHtml(err.message)}</p>`;
    }
  }

  function stopPoll() {
    window.clearInterval(pollTimer);
    pollTimer = 0;
  }

  async function startTicket() {
    const box = document.getElementById("ticket-status");
    try {
      const data = await api("/api/netlify/cli/request", { method: "POST", body: "{}" });
      if (box) {
        box.innerHTML = `<p class="account-copy">Open this URL and approve access. This page will update when you return.</p>
          <p><a class="btn btn-primary" href="${escapeHtml(data.url)}" rel="noopener" target="_blank">Approve in Netlify</a></p>
          <p class="account-copy">Waiting for approval…</p>`;
      }
      stopPoll();
      pollTimer = window.setInterval(async () => {
        try {
          const check = await api(`/api/netlify/cli/check?ticket=${encodeURIComponent(data.ticketId)}`);
          if (check.status === "authorized") {
            stopPoll();
            render(check);
          } else if (check.status === "denied" || check.status === "expired") {
            stopPoll();
            if (box) box.innerHTML = `<p class="account-error">The ticket was ${escapeHtml(check.status)}. Start a new one to try again.</p>`;
          }
        } catch (err) {
          stopPoll();
          if (box) box.innerHTML = `<p class="account-error">${escapeHtml(err.message)}</p>`;
        }
      }, 3000);
    } catch (err) {
      if (box) box.innerHTML = `<p class="account-error">${escapeHtml(err.message)}</p>`;
    }
  }

  async function startOauth() {
    try {
      const data = await api("/api/netlify/oauth/start", { method: "POST", body: "{}" });
      if (data.url) window.location.href = data.url;
    } catch (err) {
      showError(err.message);
    }
  }

  els.panel?.addEventListener("click", async (e) => {
    if (e.target.closest("#start-ticket")) startTicket();
    if (e.target.closest("#start-oauth")) startOauth();
    if (e.target.closest("#refresh-sites")) {
      try {
        const data = await api("/api/netlify/sites?refresh=1");
        render(data);
      } catch (err) {
        showError(err.message);
      }
    }
    if (e.target.closest("#disconnect-netlify")) {
      try {
        await api("/api/netlify/disconnect", { method: "POST", body: "{}" });
        await refresh();
      } catch (err) {
        showError(err.message);
      }
    }
  });

  els.panel?.addEventListener("submit", async (e) => {
    if (!e.target.closest("#token-form")) return;
    e.preventDefault();
    const input = document.getElementById("netlify-token");
    const token = input?.value || "";
    if (input) input.value = "";
    try {
      const data = await api("/api/netlify/token", { method: "POST", body: JSON.stringify({ token }) });
      render(data);
    } catch (err) {
      showError(err.message);
    }
  });

  document.getElementById("open-account")?.addEventListener("click", openDrawer);
  document.getElementById("close-account")?.addEventListener("click", closeDrawer);
  els.backdrop?.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
  });

  const params = new URLSearchParams(window.location.search);
  if (params.get("account") === "linked") {
    openDrawer();
    history.replaceState({}, "", window.location.pathname);
  } else if (params.get("account") === "error") {
    openDrawer();
    const reason = params.get("reason") || "oauth-failed";
    setTimeout(() => showError(`Netlify OAuth did not complete (${reason}).`), 400);
    history.replaceState({}, "", window.location.pathname);
  } else {
    refresh();
  }

  window.CoveAccount = { openDrawer, closeDrawer, refresh, setBackdrop };
})();
