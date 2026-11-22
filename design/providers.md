# Cove AI providers — research and behavior

Cove can answer with a local CLI on the machine hosting the session, or with a cloud model using credentials the user supplies. Cloud keys stay in `sessionStorage` in the user’s browser tab, are sent only on `/api/chat`, and are not written to disk or application logs.

## What actually offers user OAuth for inference

This is about a **third-party app calling a model on the user’s account**, not “Sign in with X” for identity alone, and not the vendor’s own chat app.

| Provider | User-facing OAuth for third-party inference? | What Cove does |
| --- | --- | --- |
| **OpenRouter** | **Yes.** Official PKCE flow: send the user to `https://openrouter.ai/auth` with `callback_url`, `code_challenge`, and `code_challenge_method=S256`, then `POST https://openrouter.ai/api/v1/auth/keys` with the `code` and `code_verifier` to receive a user-billed `sk-or-v1-` key. Docs: [OAuth PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth) and [exchange code for API key](https://openrouter.ai/docs/api/api-reference/oauth/exchange-authorization-code-for-api-key). | **Sign in with OpenRouter** is implemented. The key is kept in this tab’s session only. |
| **OpenAI** | **Partial, not generally available to an unregistered hosted app.** [Sign in with ChatGPT](https://developers.openai.com/siwc/quickstart) can, with the right scopes, use a user’s ChatGPT plan for [Responses API](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) calls. That plan-usage path is documented for [open-source / locally hosted apps](https://developers.openai.com/siwc/token-sharing-open-source); **commercial or remotely hosted apps must be accepted through a partner / interest-form trial**. Cove is not registered, and the public `*.netlify.live` URL is a hosted surface. | **Bring your own API key** from [platform.openai.com/api-keys](https://platform.openai.com/api-keys). No fake “Sign in with ChatGPT” button. |
| **Anthropic / Claude** | **Not for Claude.ai / Pro / Max subscriptions.** API access is [API keys](https://console.anthropic.com/settings/keys). Anthropic has documented organization / platform OAuth in limited beta for console billing, not a general “sign in with Claude” that a community app can use for a consumer subscription. Docs: [docs.anthropic.com](https://docs.anthropic.com/). | **Bring your own API key.** No fake Claude sign-in. |
| **Google / Gemini** | **No official consumer-subscription OAuth for third-party inference.** Apps use a [Gemini API key](https://aistudio.google.com/apikey) (AI Studio / Vertex). Google sign-in can identify a user; it does not grant Cove the user’s Gemini Pro or Ultra quota. Gemini CLI’s earlier consumer Google login was discontinued in favor of API keys. Docs: [ai.google.dev](https://ai.google.dev/). | **Bring your own API key.** No fake Google sign-in for Gemini. |
| **xAI / Grok** | **No clearly documented third-party OAuth program for model inference.** Official docs and the [xAI console](https://console.x.ai/) use API keys. [docs.x.ai](https://docs.x.ai/). An X (Twitter) OAuth login would be social identity, not Grok API access. | **Bring your own API key.** No fake “X sign in” button for Grok. |

## Local CLIs (Phase D2)

When Cove runs on a machine, `GET /api/providers` probes real binaries and only lists ones that run. Each call uses `spawn` with an argv array, a throwaway cwd, a timeout, and no shell — the same style of guard as `agy`.

On zothos, these were detected as **runnable**: `agy` (`--print --sandbox`), `hermes` (`--safe-mode`, never `--yolo`), `muse` (`muse exec` with shell and web tools disabled), and `grok` (Grok CLI `--single`, not the Grok Bot desktop app).

These were **present but not offered**, because they are wrappers, not a confirmed official CLI:

- `~/.local/bin/claude` is the “ZOTHOS Anthropic Claude Code Sovereign Agent Workstation” installer harness, not official Claude Code.
- `~/.local/bin/codex` is a “Sovereign Agent Bridge Mandatory Gatekeeper Wrapper,” not a confirmed Codex CLI we can safely run non-interactively.
- Grok Bot itself is a desktop app and has no non-interactive CLI of its own; the `grok` CLI is the one listed above.

## Environment

Cloud models can be overridden with `COVE_OPENROUTER_MODEL`, `COVE_OPENAI_MODEL`, `COVE_ANTHROPIC_MODEL`, `COVE_GEMINI_MODEL`, and `COVE_XAI_MODEL`. The default provider is `agy`, or `COVE_PROVIDER`. No cloud API keys belong in the environment for this design — users paste them in the browser, or complete OpenRouter OAuth.
