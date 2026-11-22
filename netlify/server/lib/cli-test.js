import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function parseSafe(command) {
  const parts = String(command || "").trim().split(/\s+/);
  if (parts[0] !== "netlify") return null;
  if (parts.length === 2 && parts[1] === "--version") return ["--version"];
  if (parts.length === 2 && parts[1] === "-v") return ["--version"];
  if (parts.at(-1) === "--help") {
    const mid = parts.slice(1, -1);
    if (mid.every((s) => /^[a-zA-Z0-9:_-]+$/.test(s))) {
      return [...mid, "--help"];
    }
  }
  return null;
}

export async function runSafeNetlify(command, { timeoutMs = 15_000 } = {}) {
  const args = parseSafe(command);
  if (!args) {
    return {
      ok: false,
      command,
      reason: "Rejected: only read-only `netlify --version` and `netlify [command] --help` are allowed.",
    };
  }
  try {
    const { stdout, stderr } = await execFileAsync("netlify", args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: "C.UTF-8",
      },
    });
    const output = `${stdout || ""}\n${stderr || ""}`.trim();
    return { ok: true, command: `netlify ${args.join(" ")}`, output: output.slice(0, 20_000) };
  } catch (err) {
    const output = `${err.stdout || ""}\n${err.stderr || ""}\n${err.message || ""}`.trim();
    return {
      ok: false,
      command: `netlify ${args.join(" ")}`,
      reason: "Command failed",
      output: output.slice(0, 8000),
    };
  }
}

export async function getCliVersion() {
  const result = await runSafeNetlify("netlify --version");
  const match = result.output?.match(/netlify-cli\/([\d.]+)/);
  return {
    raw: result.output || "",
    version: match ? match[1] : null,
    ok: Boolean(result.ok && match),
  };
}

export function helpMentions(output, needle) {
  const text = String(output || "").toLowerCase();
  return text.includes(String(needle).toLowerCase());
}
