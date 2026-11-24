/**
 * Pluggable model providers.
 *
 * Local CLIs are discovered on the host. Cloud providers use a key the
 * browser sends per request (or an OpenRouter PKCE key stored in the tab).
 * Never log API keys.
 */
export { ProviderError } from "./provider-error.js";
import { AgyProvider } from "./agy.js";
import { detectLocalClis, createLocalCliProvider } from "./local-clis.js";
import { CLOUD_CATALOG, createCloudProvider } from "./cloud-providers.js";
import { probeBridge } from "./signal-bridge.js";

export class EchoProvider {
  constructor() {
    this.id = "echo";
    this.label = "Echo (test only)";
    this.kind = "test";
  }

  async available() {
    return { ok: true };
  }

  async *stream({ messages }) {
    const last = messages[messages.length - 1]?.content || "";
    const reply = `Echo provider is active, so this is not a model answer.\n\nYou asked:\n\n${last}`;
    for (const part of reply.split(/(\s+)/)) {
      if (part) yield part;
    }
  }
}

const registry = new Map();

export function registerProvider(provider) {
  registry.set(provider.id, provider);
}

export function getProvider(id) {
  const wanted = id || process.env.COVE_PROVIDER || "agy";
  return registry.get(wanted) || registry.get("agy");
}

export function listProviders() {
  return [...registry.values()].map((p) => ({ id: p.id, label: p.label, kind: p.kind || "unknown" }));
}

registerProvider(new AgyProvider());
registerProvider(new EchoProvider());
for (const entry of CLOUD_CATALOG) registerProvider(createCloudProvider(entry));
for (const id of ["agy", "hermes", "muse", "grok"]) {
  const local = createLocalCliProvider(id);
  if (local && id !== "agy") registerProvider(local);
}

export async function providerCatalog() {
  const local = await detectLocalClis();
  const bridge = await probeBridge();
  return {
    ok: true,
    defaultId: process.env.COVE_PROVIDER || "agy",
    signalBridge: {
      ok: !!bridge.ok,
      url: bridge.url,
      transport: bridge.ok ? "signal-bridge" : "direct-cli-fallback",
      reason: bridge.ok ? null : bridge.reason || null,
    },
    local,
    cloud: CLOUD_CATALOG.map((entry) => ({
      id: entry.id,
      label: entry.label,
      auth: entry.auth,
      authLabel: entry.authLabel,
      docs: entry.docs,
      keyUrl: entry.keyUrl || null,
      model: entry.model,
      kind: "cloud",
    })),
    skipped: [
      { id: "claude", reason: "The claude binaries on this host are an installer harness; official Claude Code is not installed, so it is not offered." },
      { id: "codex", reason: "The codex binaries on this host are a gatekeeper/harness wrapper, not a confirmed runnable Codex CLI, so it is not offered." },
      { id: "grok-bot", reason: "grok-bot is a desktop app, not a non-interactive CLI." },
    ],
  };
}
