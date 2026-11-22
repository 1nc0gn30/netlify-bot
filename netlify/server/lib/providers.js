/**
 * Pluggable model providers.
 *
 * The default provider is AgyProvider, which calls the local `agy` CLI on this
 * machine. Swap it by setting COVE_PROVIDER=echo (for tests) or by adding a
 * new class and registering it in `providers`. A later hosted provider can
 * talk to a remote API without changing the chat or research routes.
 */
export class ProviderError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.status = status;
  }
}

export class EchoProvider {
  constructor() {
    this.id = "echo";
    this.label = "Echo (test only)";
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

export function getProvider() {
  const id = process.env.COVE_PROVIDER || "agy";
  const provider = registry.get(id) || registry.get("agy");
  if (!provider) {
    throw new ProviderError("No model provider is registered.", 500);
  }
  return provider;
}

export function listProviders() {
  return [...registry.values()].map((p) => ({ id: p.id, label: p.label }));
}
