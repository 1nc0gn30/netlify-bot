(() => {
  const root = document.getElementById("buoy");
  if (!root) return;

  const canvas = document.getElementById("mascot-fx");
  const prompt = document.getElementById("prompt");
  const eyes = document.getElementById("bot-eyes");
  const wave = document.getElementById("bot-wave");
  const stateLabel = document.getElementById("bot-state-label");
  const statePill = document.getElementById("bot-state-pill");
  const speechText = document.getElementById("bot-speech-text");
  const pingBtn = document.getElementById("bot-ping-btn");
  const moodBtn = document.getElementById("bot-mood-cycle");
  const soundToggle = document.getElementById("toggle-sound");

  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const ctx = canvas && canvas.getContext ? canvas.getContext("2d") : null;

  const offset = { x: 0, y: 0, tx: 0, ty: 0 };
  const eyePos = { x: 0, y: 0, tx: 0, ty: 0 };
  const bursts = [];
  const orbitNodes = [
    { angle: 0.4, speed: 0.34, rx: 0.41, ry: 0.28, label: "CLI" },
    { angle: 2.5, speed: 0.28, rx: 0.44, ry: 0.31, label: "TOML" },
    { angle: 4.6, speed: 0.31, rx: 0.39, ry: 0.25, label: "EDGE" },
  ];

  let mood = root.dataset.mood || "idle";
  let reactTimer = 0;
  let blinkTimer = 0;
  let speechTimer = 0;
  let raf = 0;
  let dpr = 1;
  let width = 0;
  let height = 0;
  let audioCtx = null;
  let soundOn = localStorage.getItem("cove-sound") === "1";

  const IMAGE = {
    idle: "idle",
    listening: "idle",
    success: "idle",
    excited: "idle",
    error: "idle",
    thinking: "thinking",
    talking: "talking",
    code: "talking",
  };

  const MOOD_LABELS = {
    idle: "ONLINE · IDLE",
    listening: "LISTENING · READY",
    thinking: "THINKING · SCANNING DOCS",
    talking: "STREAMING · REPLYING",
    code: "CODE MODE · SNIPPET READY",
    success: "VERIFIED · COMPLETE",
    excited: "ONLINE · PING OK",
    error: "ALERT · CHECK INPUT",
  };

  const BOT_TIPS = [
    "Tip: Put specific redirects above /* /index.html 200 so the SPA catch-all never shadows API routes.",
    "Tip: Type / in the chat composer to jump straight to netlify.toml Studio, Redirect Simulator, or CLI Forge.",
    "Tip: Run netlify dev --live to share a temporary .netlify.live tunnel without deploying to production.",
    "Tip: Use Netlify Blobs (getStore) for fast key-value state inside Functions without provisioning a DB.",
    "Tip: Add force = true (or 301!) on a redirect when you want it to override an existing static file.",
    "Tip: All workbench tools below run 100% locally in your browser — click Ask Cove to review any config.",
  ];
  let tipIndex = 0;

  function reduced() {
    return motion.matches;
  }

  function syncSoundButton() {
    if (!soundToggle) return;
    soundToggle.setAttribute("aria-pressed", String(soundOn));
    soundToggle.classList.toggle("is-active", soundOn);
  }

  function playTone(kind = "boop") {
    if (!soundOn) return;
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return;
    try {
      if (!audioCtx) audioCtx = new AudioCtor();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      if (kind === "boop") {
        osc.type = "sine";
        osc.frequency.setValueAtTime(520, now);
        osc.frequency.exponentialRampToValueAtTime(780, now + 0.09);
        gain.gain.setValueAtTime(0.06, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
        osc.start(now);
        osc.stop(now + 0.15);
      } else if (kind === "success") {
        osc.type = "triangle";
        osc.frequency.setValueAtTime(587.3, now);
        osc.frequency.setValueAtTime(880, now + 0.08);
        gain.gain.setValueAtTime(0.05, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
        osc.start(now);
        osc.stop(now + 0.24);
      } else if (kind === "error") {
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(240, now);
        osc.frequency.exponentialRampToValueAtTime(160, now + 0.14);
        gain.gain.setValueAtTime(0.04, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
        osc.start(now);
        osc.stop(now + 0.2);
      } else {
        osc.type = "sine";
        osc.frequency.setValueAtTime(660, now);
        gain.gain.setValueAtTime(0.035, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
        osc.start(now);
        osc.stop(now + 0.08);
      }
    } catch {
      /* ignore audio errors */
    }
  }

  function say(text, { duration = 5200 } = {}) {
    if (!speechText || !text) return;
    speechText.textContent = text;
    window.clearTimeout(speechTimer);
    if (duration > 0) {
      speechTimer = window.setTimeout(() => {
        if (mood === "idle") {
          speechText.textContent = "Ready to inspect configs, simulate redirects, or answer Netlify CLI questions. Click me for a tip.";
        }
      }, duration);
    }
  }

  function spawnBurst(color = "rgba(1, 212, 229, 0.7)") {
    bursts.push({ born: performance.now(), color });
    if (bursts.length > 6) bursts.shift();
  }

  function setMood(next, { hold = 0, speech = "" } = {}) {
    const name = IMAGE[next] ? next : "idle";
    mood = name;
    root.dataset.mood = name;
    root.dataset.state = IMAGE[name];
    if (stateLabel) stateLabel.textContent = MOOD_LABELS[name] || MOOD_LABELS.idle;
    if (statePill) statePill.dataset.mood = name;
    if (speech) say(speech);
    if (name === "success" || name === "excited") {
      spawnBurst("rgba(16, 221, 196, 0.75)");
      playTone("success");
    } else if (name === "error") {
      spawnBurst("rgba(255, 143, 85, 0.75)");
      playTone("error");
    } else if (name === "code") {
      spawnBurst("rgba(95, 242, 255, 0.7)");
      playTone("success");
    }
    window.clearTimeout(reactTimer);
    const linger = hold || (name === "success" || name === "error" || name === "code" || name === "excited" ? 2000 : 0);
    if (linger) {
      reactTimer = window.setTimeout(() => {
        if (mood === name) setMood("idle");
      }, linger);
    }
  }

  function boop() {
    root.classList.remove("is-booped");
    void root.offsetWidth;
    root.classList.add("is-booped");
    spawnBurst("rgba(1, 212, 229, 0.85)");
    playTone("boop");
    const tip = BOT_TIPS[tipIndex % BOT_TIPS.length];
    tipIndex += 1;
    setMood("excited", { hold: 1600, speech: tip });
  }

  function scheduleBlink() {
    window.clearTimeout(blinkTimer);
    const delay = 2600 + Math.random() * 3400;
    blinkTimer = window.setTimeout(() => {
      if (!reduced() && (mood === "idle" || mood === "listening")) {
        root.classList.add("is-blinking");
        window.setTimeout(() => root.classList.remove("is-blinking"), 150);
      }
      scheduleBlink();
    }, delay);
  }

  function resize() {
    if (!canvas || !ctx) return;
    const rect = root.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function updateWaveBars(now) {
    if (!wave) return;
    const bars = wave.querySelectorAll(".wave-bar");
    if (!bars.length) return;
    const t = now / 1000;
    const active = mood === "talking" || mood === "thinking" || mood === "listening";
    bars.forEach((bar, idx) => {
      let h = 4;
      if (mood === "talking") {
        h = 5 + Math.abs(Math.sin(t * 9.5 + idx * 0.9)) * 13;
      } else if (mood === "thinking") {
        h = 4 + Math.abs(Math.sin(t * 5.2 + idx * 0.65)) * 9;
      } else if (mood === "listening") {
        h = 4 + Math.abs(Math.sin(t * 3.1 + idx * 0.7)) * 5;
      } else if (mood === "excited" || mood === "success") {
        h = 6 + Math.abs(Math.cos(t * 7 + idx)) * 8;
      } else if (!active) {
        h = 3.5 + (idx === 3 ? 2 : idx === 2 || idx === 4 ? 1 : 0);
      }
      const y = 148 - h / 2;
      bar.setAttribute("height", h.toFixed(1));
      bar.setAttribute("y", y.toFixed(1));
    });
  }

  function drawFx(now) {
    if (!ctx || !width) return;
    ctx.clearRect(0, 0, width, height);
    if (reduced()) return;

    const cx = width * 0.5;
    const cy = height * 0.5;
    const t = now / 1000;
    const isActive = mood === "thinking" || mood === "talking" || mood === "code" || mood === "excited";
    const intensity = mood === "thinking" ? 1 : mood === "talking" ? 0.78 : mood === "excited" ? 0.9 : 0.35;

    // Soft ambient cyan halo behind the bot
    const glow = ctx.createRadialGradient(cx, cy, 8, cx, cy, Math.min(width, height) * 0.48);
    glow.addColorStop(0, `rgba(1, 212, 229, ${0.22 * intensity})`);
    glow.addColorStop(0.55, `rgba(96, 222, 236, ${0.07 * intensity})`);
    glow.addColorStop(1, "rgba(1, 212, 229, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);

    // Subtle orbital telemetry ring + floating nodes
    ctx.save();
    ctx.strokeStyle = `rgba(1, 212, 229, ${isActive ? 0.24 : 0.12})`;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.ellipse(cx, cy + 4, width * 0.36, height * 0.36, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    for (const node of orbitNodes) {
      const a = node.angle + t * node.speed * (isActive ? 1.8 : 1);
      const nx = cx + Math.cos(a) * (width * node.rx);
      const ny = cy + Math.sin(a) * (height * node.ry);
      ctx.beginPath();
      ctx.arc(nx, ny, isActive ? 3.2 : 2.3, 0, Math.PI * 2);
      ctx.fillStyle = isActive ? "rgba(1, 212, 229, 0.85)" : "rgba(1, 212, 229, 0.45)";
      ctx.fill();
    }

    // Active sonar ripples when thinking/talking/code
    if (isActive) {
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < 3; i += 1) {
        const phase = (t * 0.55 + i / 3) % 1;
        const radius = 26 + phase * (Math.min(width, height) * 0.44);
        ctx.beginPath();
        ctx.ellipse(cx, cy + 6, radius * 1.18, radius * 0.62, 0, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(1, 212, 229, ${(1 - phase) * 0.35})`;
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
    }

    // Click / reaction shockwave bursts
    for (let i = bursts.length - 1; i >= 0; i -= 1) {
      const age = (now - bursts[i].born) / 700;
      if (age >= 1) {
        bursts.splice(i, 1);
        continue;
      }
      const r = 24 + age * (Math.min(width, height) * 0.52);
      ctx.beginPath();
      ctx.ellipse(cx, cy + 4, r * 1.12, r * 0.75, 0, 0, Math.PI * 2);
      ctx.strokeStyle = bursts[i].color.replace(/[\d.]+\)$/, `${((1 - age) * 0.75).toFixed(2)})`);
      ctx.lineWidth = 2.4 * (1 - age) + 0.6;
      ctx.stroke();
    }
    ctx.restore();
  }

  function applyParallax() {
    const ease = 0.12;
    offset.x += (offset.tx - offset.x) * ease;
    offset.y += (offset.ty - offset.y) * ease;
    eyePos.x += (eyePos.tx - eyePos.x) * 0.18;
    eyePos.y += (eyePos.ty - eyePos.y) * 0.18;
    if (Math.abs(offset.x) < 0.04) offset.x = 0;
    if (Math.abs(offset.y) < 0.04) offset.y = 0;
    root.style.setProperty("--mx", `${offset.x.toFixed(2)}px`);
    root.style.setProperty("--my", `${offset.y.toFixed(2)}px`);
    if (eyes) {
      eyes.style.transform = `translate3d(${eyePos.x.toFixed(2)}px, ${eyePos.y.toFixed(2)}px, 0)`;
    }
  }

  function tick(now) {
    applyParallax();
    updateWaveBars(now);
    drawFx(now);
    raf = window.requestAnimationFrame(tick);
  }

  function startLoop() {
    if (raf || reduced()) return;
    raf = window.requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (!raf) return;
    window.cancelAnimationFrame(raf);
    raf = 0;
    offset.tx = 0;
    offset.ty = 0;
    offset.x = 0;
    offset.y = 0;
    eyePos.tx = 0;
    eyePos.ty = 0;
    eyePos.x = 0;
    eyePos.y = 0;
    root.style.setProperty("--mx", "0px");
    root.style.setProperty("--my", "0px");
    if (eyes) eyes.style.transform = "none";
    if (ctx && width) ctx.clearRect(0, 0, width, height);
  }

  function pointToward(clientX, clientY, amountX, amountY) {
    const rect = root.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const nx = ((clientX - (rect.left + rect.width / 2)) / rect.width) * 2;
    const ny = ((clientY - (rect.top + rect.height / 2)) / rect.height) * 2;
    const cx = Math.max(-1, Math.min(1, nx));
    const cy = Math.max(-1, Math.min(1, ny));
    offset.tx = cx * amountX;
    offset.ty = cy * amountY;
    eyePos.tx = cx * 9;
    eyePos.ty = cy * 6;
  }

  function onPointer(event) {
    if (reduced()) return;
    pointToward(event.clientX, event.clientY, 6, 4);
  }

  function onPointerLeave() {
    offset.tx = 0;
    offset.ty = 0;
    eyePos.tx = 0;
    eyePos.ty = 0;
  }

  function caretTarget() {
    if (!prompt) return null;
    const rect = prompt.getBoundingClientRect();
    return { x: rect.left + Math.min(rect.width * 0.42, 120), y: rect.top + rect.height / 2 };
  }

  function onPromptActivity() {
    if (document.body.dataset.coveBusy === "true") return;
    if (mood === "thinking" || mood === "talking") return;
    setMood("listening");
    const caret = caretTarget();
    if (caret && !reduced()) pointToward(caret.x, caret.y, 4, 3);
  }

  function onPromptIdle() {
    if (mood === "listening") setMood("idle");
    if (!reduced()) {
      offset.tx = 0;
      offset.ty = 0;
      eyePos.tx = 0;
      eyePos.ty = 0;
    }
  }

  let listenTimer = 0;
  function scheduleIdle() {
    window.clearTimeout(listenTimer);
    listenTimer = window.setTimeout(onPromptIdle, 1400);
  }

  root.addEventListener("click", boop);
  root.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      boop();
    }
  });

  if (pingBtn) {
    pingBtn.addEventListener("click", () => {
      const t0 = performance.now();
      const provider = document.getElementById("status-provider")?.textContent || "checking";
      const knowledge = document.getElementById("status-knowledge")?.textContent || "ready";
      const latency = Math.max(1, Math.round(performance.now() - t0 + 4));
      setMood("excited", {
        hold: 2200,
        speech: `Pong (${latency}ms) · Provider: ${provider} · Knowledge: ${knowledge}. All local workbench tools online.`,
      });
    });
  }

  const demoMoods = ["idle", "listening", "thinking", "talking", "code", "success"];
  let demoIdx = 0;
  if (moodBtn) {
    moodBtn.addEventListener("click", () => {
      demoIdx = (demoIdx + 1) % demoMoods.length;
      const next = demoMoods[demoIdx];
      playTone("click");
      setMood(next, { hold: next === "idle" ? 0 : 2800, speech: `Expression preview: ${MOOD_LABELS[next]}` });
    });
  }

  if (soundToggle) {
    syncSoundButton();
    soundToggle.addEventListener("click", () => {
      soundOn = !soundOn;
      localStorage.setItem("cove-sound", soundOn ? "1" : "0");
      syncSoundButton();
      if (soundOn) {
        playTone("boop");
        say("Bot sound effects enabled.");
      } else {
        say("Bot sound effects muted.");
      }
    });
  }

  window.addEventListener("pointermove", onPointer, { passive: true });
  document.documentElement.addEventListener("pointerleave", onPointerLeave, { passive: true });
  window.addEventListener("resize", resize);
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(() => resize());
    ro.observe(root);
  }
  motion.addEventListener("change", () => {
    resize();
    if (reduced()) stopLoop();
    else startLoop();
  });

  if (prompt) {
    prompt.addEventListener("focus", onPromptActivity);
    prompt.addEventListener("input", () => {
      onPromptActivity();
      scheduleIdle();
    });
    prompt.addEventListener("blur", scheduleIdle);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopLoop();
    else {
      resize();
      startLoop();
    }
  });

  resize();
  scheduleBlink();
  if (!reduced()) startLoop();
  setMood(root.dataset.mood || "idle");

  window.CoveMascot = { setMood, resize, boop, say, playTone };
})();
