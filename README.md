# Cove — Community Netlify Guide

Fan-made community helper for the Netlify CLI and platform. **Not an official Netlify product and not affiliated with Netlify.**

Cove is a chat guide with an original mascot named Buoy. It stays current by fetching [netlify.ai](https://netlify.ai) and official docs, then research-tests CLI facts with read-only help and version commands. Verified claims are written to a shareable [`/netlify-ai.md`](/netlify-ai.md).

## How it runs

The backend is a [Netlify Server](https://docs.netlify.com/build/server/) (Early Access, November 2026) at `netlify/server/index.js`. That primitive is the long-running Node.js server Netlify released for WebSockets, SSE, and work that should not be a one-shot function. A chat answer from a local model fits that model.

The shareable preview is **`netlify dev --live`**, which opens a public `.netlify.live` tunnel to this machine. That is the right “share a dev link before deploying” path.

This is not a [Preview Server](https://docs.netlify.com/manage/preview-servers/overview/). Preview Servers run `netlify dev` in a Netlify-managed container for a *linked* site and git branch. They require creating or linking a site, a git connection, and collaborator login. They also would not see `agy` on this laptop. Cove is set up so a Preview Server can be added later, but it is not used for this first share link.

## Powered by agy, on this machine only

The default model provider calls the local `agy` CLI in non-interactive `--print` mode, in a temporary directory, with `--sandbox` and a timeout. User input is never passed to a shell.

**This only works while this laptop is running the dev session.** A production deploy on Netlify will not have `agy`. Swap in a hosted provider when you are ready to deploy (see below).

## Scripts

```bash
# local only
npm run dev

# public .netlify.live link — the CLI must be logged in AND the folder must be
# linked to a Netlify project (`netlify link` or `netlify sites:create` then link).
# This repo is intentionally not linked and no site was created.
npm run dev:live
```

Default port: `8971`.

## Knowledge and the shareable guide

- On startup, on a six-hour schedule, and when you click **Refresh sources**, Cove fetches `https://netlify.ai`, `https://docs.netlify.com/llms.txt`, and key docs pages into `knowledge/cache/` (gitignored).
- **Research & test** refreshes those sources, may ask the model for extra CLI claims, then *itself* runs only:
  - `netlify --version`
  - `netlify --help`
  - `netlify <command> --help`
- Only verified claims are written to `knowledge/netlify-ai.md`, with a changelog and the test or official source behind each claim.
- The file is served at `/netlify-ai.md`. The **Share knowledge** button copies that URL.

## Provider interface

Providers live in `netlify/server/lib/providers.js`. Set `COVE_PROVIDER=agy` (default) or `COVE_PROVIDER=echo` for a no-model smoke test. Optional:

- `AGY_PATH` — path to the `agy` binary
- `COVE_AGY_MODEL` — model id (`agy models` to list)
- `COVE_AGY_EFFORT` — `low` / `medium` / `high` / …

To add a hosted provider later, implement `available()` and `stream()`, then `registerProvider(...)`.

## Live tunnel note

`netlify dev --live` exposes a public `*.netlify.live` URL over HTTP/2. Netlify Server responses are proxied as chunked HTTP/1.1 and pick up a hop-by-hop `Keep-Alive` header, which HTTP/2 clients reject (empty body, or curl error 92). Cove serves the HTTP API through a Netlify Function as well, buffering non-streaming replies with an explicit `Content-Length`. Chat tries SSE first and falls back to a JSON response.

## Safety

- Per-session rate limit and input length cap
- No shell execution of user input
- `agy` runs in a throwaway working directory
- Timeouts on chat, research, and fetches
- CLI tests are allowlisted and run with `execFile`, not a shell

## What a later deploy needs

Nothing here creates a production site, GitHub repo, or production deploy. To go live later:

1. Create and link a Netlify project (`netlify sites:create` / `netlify link`) in a team you choose.
2. Plug in a hosted model provider. Do not expect `agy` to be available on Netlify’s servers.
3. Deploy a draft with `netlify deploy` first, then production only if you want it live.
4. Optional: connect git and turn on a Preview Server in the Netlify UI for an authenticated collaborator preview. That still needs a hosted provider if you want the bot to answer off this laptop.

Use Netlify CLI 27.20.0 or later (27.17.0 is the minimum for Netlify Server). Node.js 24 or later is required in production; this project was developed on Node 24+.
