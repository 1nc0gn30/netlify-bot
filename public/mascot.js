(() => {
  const root = document.getElementById("buoy");
  if (!root) return;

  const canvas = document.getElementById("mascot-fx");
  const prompt = document.getElementById("prompt");
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const ctx = canvas && canvas.getContext ? canvas.getContext("2d") : null;

  const offset = { x: 0, y: 0, tx: 0, ty: 0 };
  let mood = root.dataset.mood || "idle";
  let reactTimer = 0;
  let raf = 0;
  let dpr = 1;
  let width = 0;
  let height = 0;

  const IMAGE = {
    idle: "idle",
    listening: "idle",
    success: "idle",
    error: "idle",
    thinking: "thinking",
    talking: "talking",
    code: "talking",
  };

  function reduced() {
    return motion.matches;
  }

  function setMood(next, { hold = 0 } = {}) {
    const name = IMAGE[next] ? next : "idle";
    mood = name;
    root.dataset.mood = name;
    root.dataset.state = IMAGE[name];
    window.clearTimeout(reactTimer);
    const linger = hold || (name === "success" || name === "error" || name === "code" ? 1400 : 0);
    if (linger) {
      reactTimer = window.setTimeout(() => {
        if (mood === name) setMood("idle");
      }, linger);
    }
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

  function drawRipple(now) {
    if (!ctx || !width) return;
    ctx.clearRect(0, 0, width, height);
    if (reduced() || (mood !== "thinking" && mood !== "talking" && mood !== "code")) return;

    const intensity = mood === "thinking" ? 1 : mood === "code" ? 0.45 : 0.58;
    const cx = width * 0.5;
    const cy = height * 0.46;
    const t = now / 1000;

    const glow = ctx.createRadialGradient(cx, cy, 6, cx, cy + 6, height * 0.46);
    glow.addColorStop(0, `rgba(1, 212, 229, ${0.28 * intensity})`);
    glow.addColorStop(0.4, `rgba(96, 222, 236, ${0.1 * intensity})`);
    glow.addColorStop(1, "rgba(1, 212, 229, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < 4; i += 1) {
      const phase = (t * 0.42 + i / 4) % 1;
      const radius = 14 + phase * (height * 0.4);
      ctx.beginPath();
      ctx.ellipse(cx, cy + 10, radius * 1.22, radius * 0.52, 0, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(1, 212, 229, ${(1 - phase) * 0.32 * intensity})`;
      ctx.lineWidth = 1.2 + (1 - phase) * 0.6;
      ctx.stroke();
    }
    const caustic = ctx.createRadialGradient(
      cx + Math.sin(t * 0.7) * 10,
      cy + Math.cos(t * 0.5) * 6,
      4,
      cx,
      cy,
      height * 0.2
    );
    caustic.addColorStop(0, `rgba(255, 255, 255, ${0.1 * intensity})`);
    caustic.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = caustic;
    ctx.beginPath();
    ctx.ellipse(cx, cy + 6, width * 0.16, height * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function applyParallax() {
    const ease = 0.12;
    offset.x += (offset.tx - offset.x) * ease;
    offset.y += (offset.ty - offset.y) * ease;
    if (Math.abs(offset.x) < 0.05) offset.x = 0;
    if (Math.abs(offset.y) < 0.05) offset.y = 0;
    root.style.setProperty("--mx", `${offset.x.toFixed(2)}px`);
    root.style.setProperty("--my", `${offset.y.toFixed(2)}px`);
  }

  function tick(now) {
    applyParallax();
    drawRipple(now);
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
    root.style.setProperty("--mx", "0px");
    root.style.setProperty("--my", "0px");
    if (ctx && width) ctx.clearRect(0, 0, width, height);
  }

  function pointToward(clientX, clientY, amountX, amountY) {
    const rect = root.getBoundingClientRect();
    const nx = ((clientX - (rect.left + rect.width / 2)) / rect.width) * 2;
    const ny = ((clientY - (rect.top + rect.height / 2)) / rect.height) * 2;
    offset.tx = Math.max(-1, Math.min(1, nx)) * amountX;
    offset.ty = Math.max(-1, Math.min(1, ny)) * amountY;
  }

  function onPointer(event) {
    if (reduced()) return;
    pointToward(event.clientX, event.clientY, 7, 4);
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
    if (caret && !reduced()) pointToward(caret.x, caret.y, 5, 3);
  }

  function onPromptIdle() {
    if (mood === "listening") setMood("idle");
    if (!reduced()) {
      offset.tx = 0;
      offset.ty = 0;
    }
  }

  let listenTimer = 0;
  function scheduleIdle() {
    window.clearTimeout(listenTimer);
    listenTimer = window.setTimeout(onPromptIdle, 1400);
  }

  window.addEventListener("pointermove", onPointer, { passive: true });
  window.addEventListener("resize", resize);
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
  if (!reduced()) startLoop();
  setMood(root.dataset.mood || "idle");

  window.CoveMascot = { setMood, resize };
})();
