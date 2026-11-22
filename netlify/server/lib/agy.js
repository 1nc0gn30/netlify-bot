import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { ProviderError } from "./provider-error.js";
import { LIMITS } from "./guards.js";

function resolveAgy() {
  if (process.env.AGY_PATH && existsSync(process.env.AGY_PATH)) return process.env.AGY_PATH;
  const home = join(homedir(), ".local/bin/agy");
  if (existsSync(home)) return home;
  return "agy";
}

function parseStreamLine(line, { alreadyStreaming }) {
  const raw = line.trim();
  if (!raw) return { text: "", final: false };
  try {
    const ev = JSON.parse(raw);
    if (typeof ev === "string") return { text: ev, final: false };
    if (ev.event === "step_update" && ev.step_update?.text_delta) {
      return { text: ev.step_update.text_delta, final: ev.step_update.state === "DONE" && alreadyStreaming };
    }
    if (ev.event === "result") {
      const status = ev.result?.status || "";
      if (status && status !== "SUCCESS") {
        return { text: "", final: true, error: ev.result?.error || ev.result?.message || `agy status ${status}` };
      }
      if (alreadyStreaming) return { text: "", final: true };
      return { text: ev.result?.response || "", final: true };
    }
    const type = ev.type || ev.event || ev.kind || "";
    if (type === "error" || ev.error) {
      const message = ev.error?.message || ev.message || ev.error || "agy reported an error";
      return { text: "", final: false, error: String(message) };
    }
    if (["content_block_delta", "text_delta", "token", "output_text", "content_delta"].includes(type)) {
      return { text: ev.delta?.text || ev.text || ev.content || ev.output || "", final: false };
    }
    if (ev.delta && typeof ev.delta === "string") return { text: ev.delta, final: false };
    if (typeof ev.text === "string" && !["result", "final", "assistant", "message"].includes(type)) {
      return { text: ev.text, final: false };
    }
    if (type === "result" || type === "final" || ev.result || ev.is_final) {
      if (alreadyStreaming) return { text: "", final: true };
      const text = ev.result || ev.output || ev.text || ev.message || ev.response || "";
      return { text: typeof text === "string" ? text : "", final: true };
    }
    if (ev.message?.content && typeof ev.message.content === "string") {
      return { text: alreadyStreaming ? "" : ev.message.content, final: type === "assistant" };
    }
    if (Array.isArray(ev.message?.content)) {
      const text = ev.message.content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("");
      return { text: alreadyStreaming ? "" : text, final: false };
    }
    return { text: "", final: false };
  } catch {
    if (raw.startsWith("data:")) return { text: "", final: false };
    return { text: raw, final: false };
  }
}

export class AgyProvider {
  constructor() {
    this.id = "agy";
    this.label = "agy (local Gemini CLI)";
  }

  async available() {
    const bin = resolveAgy();
    if (bin !== "agy" && !existsSync(bin)) {
      return { ok: false, reason: "agy was not found on this machine." };
    }
    return { ok: true, bin };
  }

  async *stream({ systemPrompt, signal, timeoutMs }) {
    const ready = await this.available();
    if (!ready.ok) throw new ProviderError(ready.reason);
    const bin = ready.bin || resolveAgy();
    const cwd = await mkdtemp(join(tmpdir(), "cove-agy-"));
    const logFile = join(cwd, "agy.log");

    const format = process.env.COVE_AGY_FORMAT || "stream-json";
    const args = [
      "--print",
      systemPrompt,
      "--sandbox",
      "--disable-slash-commands",
      "--print-timeout",
      `${Math.ceil((timeoutMs || LIMITS.chatTimeoutMs) / 1000)}s`,
      "--output-format",
      format,
      "--add-dir",
      cwd,
      "--log-file",
      logFile,
    ];
    if (process.env.COVE_AGY_MODEL) args.push("--model", process.env.COVE_AGY_MODEL);
    if (process.env.COVE_AGY_EFFORT) args.push("--effort", process.env.COVE_AGY_EFFORT);

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
      child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      await rm(cwd, { recursive: true, force: true });
      throw new ProviderError(`Could not start agy: ${err.message}`);
    }

    const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs || LIMITS.chatTimeoutMs);
    if (signal) {
      if (signal.aborted) child.kill("SIGTERM");
      else signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    }

    let buffer = "";
    let stderr = "";
    let produced = false;
    const queue = [];
    let pending = null;
    let done = false;
    let exitError = null;

    const push = (value, err) => {
      if (pending) {
        const { resolve, reject } = pending;
        pending = null;
        if (err) reject(err);
        else resolve(value);
      } else {
        queue.push({ value, err });
      }
    };

    const onData = (chunk) => {
      const str = chunk.toString("utf8");
      if (format !== "stream-json") {
        if (str) {
          produced = true;
          push(str);
        }
        return;
      }
      buffer += str;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const parsed = parseStreamLine(line, { alreadyStreaming: produced });
        if (parsed.error) exitError = new ProviderError(parsed.error);
        if (parsed.text) {
          produced = true;
          push(parsed.text);
        }
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      exitError = new ProviderError(`agy failed to start: ${err.message}`);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (format === "stream-json" && buffer.trim()) {
        const parsed = parseStreamLine(buffer, { alreadyStreaming: produced });
        if (parsed.text) {
          produced = true;
          push(parsed.text);
        }
      }
      done = true;
      if (!produced && code && code !== 0) {
        exitError = exitError || new ProviderError(`agy exited with code ${code}. ${stderr.slice(0, 400)}`.trim());
      }
      push(null, exitError);
    });

    try {
      while (true) {
        let item;
        if (queue.length) {
          item = queue.shift();
        } else if (done) {
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
      if (!produced) {
        throw new ProviderError(`agy returned no text. ${stderr.slice(0, 400)}`.trim());
      }
    } finally {
      clearTimeout(timeout);
      if (child.exitCode == null && !child.killed) child.kill("SIGTERM");
      setTimeout(() => rm(cwd, { recursive: true, force: true }).catch(() => {}), 2000);
    }
  }
}
