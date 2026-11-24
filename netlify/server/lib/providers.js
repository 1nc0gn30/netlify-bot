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
import { isLocalProviderId, localAgentsOptedIn } from "./local-access.js";

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

export function getProvider(id, { localAccess = false } = {}) {
  const requested = id || process.env.COVE_PROVIDER || "";
  const allowLocal = localAgentsOptedIn() && localAccess;
  const wanted = requested || (allowLocal ? "agy" : "");
  if (!wanted) return null;
  const provider = registry.get(wanted);
  if (!provider) return null;
  if (isLocalProviderId(provider.id) && !allowLocal) return provider;
  return provider;
}

export function listProviders({ localAccess = false } = {}) {
  const allowLocal = localAgentsOptedIn() && localAccess;
  return [...registry.values()]
    .filter((p) => allowLocal || !isLocalProviderId(p.id))
    .map((p) => ({ id: p.id, label: p.label, kind: p.kind || "unknown" }));
}

registerProvider(new AgyProvider());
registerProvider(new EchoProvider());
for (const entry of CLOUD_CATALOG) registerProvider(createCloudProvider(entry));
for (const id of ["agy", "hermes", "muse", "grok"]) {
  const local = createLocalCliProvider(id);
  if (local && id !== "agy") registerProvider(local);
}

const PUBLIC_SKIPPED = [];

const LOCAL_SKIPPED = [
  { id: "claude", reason: "The claude binaries on this host are an installer harness; official Claude Code is not installed, so it is not offered." },
  { id: "codex", reason: "The codex binaries on this host are a gatekeeper/harness wrapper, not a confirmed runnable Codex CLI, so it is not offered." },
  { id: "grok-bot", reason: "grok-bot is a desktop app, not a non-interactive CLI." },
];

export async function providerCatalog({ localAccess = false } = {}) {
  const allowLocal = localAgentsOptedIn() && localAccess;
  const local = allowLocal ? await detectLocalClis() : [];
  const bridge = allowLocal
    ? await probeBridge()
    : {
        ok: false,
        url: null,
        reason: "Local agents and the Signal Bridge are only available when Cove is used on this machine.",
      };
  const envDefault = process.env.COVE_PROVIDER;
  let defaultId = null;
  if (allowLocal) {
    const envOk = envDefault && (!isLocalProviderId(envDefault) || local.some((item) => item.id === envDefault));
    defaultId = envOk ? envDefault : (local.some((item) => item.id === "agy") ? "agy" : (local[0]?.id || null));
  } else if (envDefault && !isLocalProviderId(envDefault)) {
    defaultId = envDefault;
  }
  return {
    ok: true,
    defaultId,
    localAgents: allowLocal,
    signalBridge: allowLocal
      ? {
          ok: !!bridge.ok,
          url: bridge.url,
          transport: bridge.ok ? "signal-bridge" : "direct-cli-fallback",
          reason: bridge.ok ? null : bridge.reason || null,
        }
      : {
          ok: false,
          url: null,
          transport: "disabled",
          reason: bridge.reason,
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
    skipped: allowLocal ? LOCAL_SKIPPED : PUBLIC_SKIPPED,
  };
}
