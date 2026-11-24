/**
 * Detect and run local coding-agent CLIs in the same spirit as agy:
 * non-interactive, execFile/spawn with an argv array, a throwaway cwd,
 * a timeout, and no shell. Only binaries that actually run are advertised.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { ProviderError } from "./provider-error.js";
import { LIMITS } from "./guards.js";
import { localAgentsOptedIn } from "./local-access.js";

const HOME_BIN = join(homedir(), ".local/bin");

function firstExisting(paths) {
  for (const candidate of paths) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function looksLikeHarness(bin) {
  try {
    const head = readFileSync(bin, { encoding: "utf8" }).slice(0, 2000);
    if (/Sovereign Agent|Official Terminal CLI Harness|not installed yet/i.test(head)) return true;
    if (/gatekeep codex|Mandatory Gatekeeper Wrapper/i.test(head)) return true;
  } catch {
    /* binary or unreadable — treat as a real executable */
  }
  return false;
}

function runTimed(bin, args, { timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = (ok, text) => {
      if (settled) return;
      settled = true;
      resolve({ ok, text: String(text || "").trim() });
    };
    let child;
    try {
      child = spawn(bin, args, {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", TERM: "dumb", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish(false, err.message);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(false, "timeout");
    }, timeoutMs);
    const on = (chunk) => {
      out += chunk.toString("utf8");
    };
    child.stdout.on("data", on);
    child.stderr.on("data", on);
    child.on("error", (err) => {
      clearTimeout(timer);
      finish(false, err.message);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const cleaned = out.replace(/\x1b\[[0-9;]*m/g, "").trim();
      const first = cleaned.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("[")) || cleaned.slice(0, 180);
      finish(code === 0 || cleaned.length > 0, first.slice(0, 180));
    });
  });
}

const RECIPES = {
  agy: {
    id: "agy",
    label: "agy",
    detail: "Local CLI already powering Cove, run with --print and --sandbox.",
    bins: [process.env.AGY_PATH, join(HOME_BIN, "agy")],
    versionArgs: ["--version"],
    args({ prompt, cwd }) {
      return ["--print", prompt, "--sandbox", "--disable-slash-commands", "--output-format", "text", "--add-dir", cwd];
    },
  },
  hermes: {
    id: "hermes",
    label: "Hermes Agent",
    detail: "One-shot --safe-mode. Never uses --yolo.",
    bins: [join(HOME_BIN, "hermes")],
    versionArgs: ["--version"],
    args({ prompt }) {
      return ["--safe-mode", "--ignore-user-config", "-z", prompt];
    },
  },
  muse: {
    id: "muse",
    label: "Muse",
    detail: "muse exec, non-interactive, sandbox on, shell disabled.",
    bins: ["/opt/muse/muse", join(HOME_BIN, "muse")],
    versionArgs: ["--version"],
    async writePrompt(cwd, prompt) {
      const file = join(cwd, "prompt.txt");
      await writeFile(file, prompt, "utf8");
      return file;
    },
    args({ promptFile, cwd }) {
      return ["exec", "--prompt-file", promptFile, "--workspace", cwd, "--disable-shell", "--disable-web-tools"];
    },
  },
  grok: {
    id: "grok",
    label: "Grok CLI",
    detail: "Headless --single prompt. The Grok Bot desktop app is not used.",
    bins: [join(homedir(), ".grok/bin/grok"), "/usr/local/bin/grok-cli", join(HOME_BIN, "grok")],
    versionArgs: ["--version"],
    args({ prompt }) {
      return ["--single", prompt, "--output-format", "plain", "--permission-mode", "dontAsk"];
    },
  },
};

const DETECT_TTL_MS = 60 * 1000;
let cachedDetection = null;
let cachedAt = 0;

async function probeRecipe(recipe) {
  const bin = firstExisting(recipe.bins);
  if (!bin) return null;
  if (looksLikeHarness(bin)) return null;
  const version = await runTimed(bin, recipe.versionArgs);
  if (!version.ok) return null;
  return {
    id: recipe.id,
    label: recipe.label,
    detail: recipe.detail,
    bin,
    version: version.text.split("\n")[0].slice(0, 120),
    kind: "local-cli",
  };
}

export async function detectLocalClis({ force = false } = {}) {
  if (!localAgentsOptedIn()) return [];
  if (!force && cachedDetection && Date.now() - cachedAt < DETECT_TTL_MS) {
    return cachedDetection;
  }
  const results = await Promise.all(Object.values(RECIPES).map(probeRecipe));
  cachedDetection = results.filter(Boolean);
  cachedAt = Date.now();
  return cachedDetection;
}

export function createLocalCliProvider(id) {
  const recipe = RECIPES[id];
  if (!recipe) return null;
  return {
    id: recipe.id,
    label: recipe.label,
    kind: "local-cli",
    async available({ localAccess = false } = {}) {
      if (!localAgentsOptedIn() || !localAccess) {
        return {
          ok: false,
          reason: `${recipe.label} is only available when Cove is used on this machine with COVE_LOCAL_AGENTS enabled.`,
        };
      }
      const [found] = (await detectLocalClis()).filter((item) => item.id === recipe.id);
      if (!found) return { ok: false, reason: `${recipe.label} is not available as a runnable CLI on this host.` };
      return { ok: true, bin: found.bin };
    },
    async *stream({ systemPrompt, signal, timeoutMs, localAccess = false }) {
      const ready = await this.available({ localAccess });
      if (!ready.ok) throw new ProviderError(ready.reason);
      const cwd = await mkdtemp(join(tmpdir(), `cove-${recipe.id}-`));
      const prompt = String(systemPrompt || "");
      let promptFile = null;
      if (recipe.writePrompt) promptFile = await recipe.writePrompt(cwd, prompt);
      const args = recipe.args({ prompt, promptFile, cwd });
      const env = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USER: process.env.USER,
        LANG: process.env.LANG || "C.UTF-8",
        TERM: "dumb",
        NO_COLOR: "1",
      };
      let child;
      try {
        child = spawn(ready.bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        await rm(cwd, { recursive: true, force: true });
        throw new ProviderError(`Could not start ${recipe.label}: ${err.message}`);
      }
      const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs || LIMITS.chatTimeoutMs);
      if (signal) {
        if (signal.aborted) child.kill("SIGTERM");
        else signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
      }
      let buffer = "";
      let stderr = "";
      const queue = [];
      let pending = null;
      let done = false;
      let exitError = null;
      let produced = false;
      const push = (value, err) => {
        if (pending) {
          const wait = pending;
          pending = null;
          if (err) wait.reject(err);
          else wait.resolve(value);
        } else queue.push({ value, err });
      };
      child.stdout.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        if (text) {
          produced = true;
          push(text);
        } else buffer += text;
      });
      child.stderr.on("data", (c) => {
        stderr += c.toString("utf8");
      });
      child.on("error", (err) => {
        exitError = new ProviderError(`${recipe.label} failed to start: ${err.message}`);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        done = true;
        if (!produced && code) exitError = exitError || new ProviderError(`${recipe.label} exited with code ${code}. ${stderr.slice(0, 300)}`.trim());
        push(null, exitError);
      });
      try {
        while (true) {
          let item;
          if (queue.length) item = queue.shift();
          else if (done) {
            if (exitError) throw exitError;
            break;
          } else {
            item = await new Promise((resolve, reject) => {
              pending = { resolve: (value) => resolve({ value }), reject };
            });
          }
          if (item.err) throw item.err;
          if (item.value == null) {
            if (exitError) throw exitError;
            break;
          }
          yield item.value;
        }
        if (!produced) throw new ProviderError(`${recipe.label} returned no text. ${stderr.slice(0, 300)}`.trim());
      } finally {
        clearTimeout(timeout);
        if (child.exitCode == null && !child.killed) child.kill("SIGTERM");
        setTimeout(() => rm(cwd, { recursive: true, force: true }).catch(() => {}), 2000);
      }
    },
  };
}
