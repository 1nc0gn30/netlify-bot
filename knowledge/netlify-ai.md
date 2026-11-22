# Community Netlify AI Guide

> Fan-made, community-maintained companion to [netlify.ai](https://netlify.ai).
> This is not an official Netlify document and is not affiliated with Netlify.
> Only claims that were checked against official pages or a read-only CLI test are listed below.

- Guide version: `0.1.0`
- Last verified: 2026-11-22T14:43:55.560Z
- CLI under test: `netlify-cli/27.20.0 linux-x64 node-v26.8.2`
- Official sources fetched: 14 of 14
- Official fetch time: 2026-11-22T14:43:29.933Z

## How this file is updated

Cove refreshes official sources (netlify.ai, docs.netlify.com/llms.txt, and key docs pages), asks its model to propose updates, then **runs the tests itself**. The model cannot write this file directly. Unsafe or unverified proposals are dropped.

Allowed tests are only:

- `netlify --version`
- `netlify --help`
- `netlify <command> --help`

## Changelog

- `0.1.0` (2026-11-22T14:43:55.558Z): Verified 14 claims against CLI 27.20.0 and 14 official sources.

## Verified claims

### cli-version

The Netlify CLI reports a version in the form netlify-cli/<version>. Official agent docs (netlify.ai) ask agents to install netlify-cli@latest and to upgrade if the installed CLI is older than 27.20.0.

- Test: `netlify --version`
- Result: pass
- Excerpt: `netlify-cli/27.20.0 linux-x64 node-v26.8.2`

### cli-help

`netlify --help` lists the CLI commands available in the installed version.

- Test: `netlify --help`
- Result: pass
- Excerpt: `ials: netlify login --request <msg> Exit codes: 0 ok, 1 error, 2 usage, 4 needs-input → For more h`

### dev-help-live

`netlify dev --live` starts a public live session. The flag accepts an optional subdomain to generate a custom URL, and the session is a tunnel from the local dev server (a .netlify.live link) rather than a production deploy.

- Test: `netlify dev --help`
- Result: pass
- Excerpt: `ons] OPTIONS -c ,--command <command> command to run --context <context>`

### login-help

`netlify login --request` is the agent-friendly login path: it prints a login URL instead of waiting on a local browser window. Official agent docs recommend it over plain `netlify login`.

- Test: `netlify login --help`
- Result: pass
- Excerpt: `options] OPTIONS --debug Print debugging information --auth <token> Ne`

### deploy-help

`netlify deploy` publishes a draft by default. A production publish uses `--prod`. Deploying from a folder that is not linked can create a new project, so the folder should be linked first.

- Test: `netlify deploy --help`
- Result: pass
- Excerpt: `options] OPTIONS --alias <name> Specifies the alias for deployment, the string`

### status-help

`netlify status` reports the logged-in account and whether the current folder is linked to a Netlify project. `--json` is available for machine-readable output.

- Test: `netlify status --help`
- Result: pass
- Excerpt: `options] OPTIONS --debug Print debugging information --auth <token> Netlify auth`

### init-help

`netlify init` can configure continuous deployment and, unless skipped, set up Netlify skills and the Netlify MCP server for AI coding agents. `--skip-agent-setup` and `--skip-mcp-setup` turn those steps off.

- Test: `netlify init --help`
- Result: pass
- Excerpt: `options] OPTIONS --filter <app> For monorepos, specify the name of the`

### sites-create-help

`netlify sites:create` creates a new Netlify project. `--name` and `--account-slug` can be passed so the command does not need an interactive prompt.

- Test: `netlify sites:create --help`
- Result: pass
- Excerpt: `ons] OPTIONS -a, --account-slug <slug> account slug to create the project under --disable-l`

### functions-help

The netlify functions command manages Netlify Functions, including subcommands to create, build, invoke, list, and serve them.

- Test: `netlify functions --help`
- Result: pass
- Excerpt: `unction locally $ functions:invoke Trigger a function while in netlify dev with simulated`

### env-help

The netlify env command manages environment variables for a linked site using subcommands such as get, set, unset, list, and import.

- Test: `netlify env --help`
- Result: pass
- Excerpt: `AR_NAME $ netlify env:set VAR_NAME value $ netlify env:unset VAR_NAME $ netlify env:import fil`

### blobs-help

The netlify blobs command manages Netlify Blobs stores with subcommands to get, set, list, and delete stored values.

- Test: `netlify blobs --help`
- Result: pass
- Excerpt: `XAMPLES $ netlify blobs:get my-store my-key $ netlify blobs:set my-store my-key This will go in`

### api-help

The netlify api command invokes Netlify API methods directly and supports listing available API methods with --list.

- Test: `netlify api --help`
- Result: pass
- Excerpt: `help for command --list List out available API methods (default: false) DESCRIPTI`

### sites-list-help

The netlify sites:list command lists all Netlify sites you have access to and supports JSON output via --json.

- Test: `netlify sites:list --help`
- Result: pass
- Excerpt: `help for command --json Output project data as JSON`

### unlink-help

The netlify unlink command disconnects the current local project directory from its linked Netlify site.

- Test: `netlify unlink --help`
- Result: pass
- Excerpt: `Unlink a local folder from a Netlify project USAGE $ netlify unlink [options]`

## Source-backed notes

These notes are taken from official pages that were fetched successfully. They were not independently CLI-tested.

- Official agent setup lives at https://netlify.ai and lists a stepwise flow: install the CLI (upgrade if older than 27.20.0), log in with `netlify login --request`, run `netlify init` for skills and MCP, then link or create a project and deploy only after the folder is linked. — source: https://netlify.ai
- Netlify Server is a long-running Node.js backend declared at `netlify/server/index.ts` (or .js/.mjs/.mts). It can hold WebSockets and SSE connections. Locally it runs with Netlify CLI 27.17.0 or later via `netlify dev`. This is separate from Preview Servers and from `netlify dev --live`. — source: https://docs.netlify.com/build/server/get-started/
- Preview Servers run `netlify dev` in a Netlify-managed container. They need a linked site, a git branch, and authenticated collaborators. The URL looks like `https://devserver-BRANCH--SITE.netlify.app`. They are not a public unauthenticated share link, and they auto-shutoff after 30 minutes of inactivity. — source: https://docs.netlify.com/manage/preview-servers/overview/

## Official sources in the latest fetch

- Netlify setup for AI agents: https://netlify.ai — ok
- Netlify docs index for LLMs: https://docs.netlify.com/llms.txt — ok
- Netlify Server overview: https://docs.netlify.com/build/server.md — ok
- Get started with Netlify Server: https://docs.netlify.com/build/server/get-started.md — ok
- Netlify Server local development: https://docs.netlify.com/build/server/local-development.md — ok
- Netlify Functions overview: https://docs.netlify.com/build/functions/overview.md — ok
- Get started with Functions: https://docs.netlify.com/build/functions/get-started.md — ok
- Edge Functions overview: https://docs.netlify.com/build/edge-functions/overview.md — ok
- Netlify Blobs: https://docs.netlify.com/build/data-and-storage/netlify-blobs.md — ok
- Netlify Forms setup: https://docs.netlify.com/manage/forms/setup.md — ok
- Redirects: https://docs.netlify.com/manage/routing/redirects/overview.md — ok
- Get started with the CLI: https://docs.netlify.com/api-and-cli-guides/cli-guides/get-started-with-cli.md — ok
- Preview Servers: https://docs.netlify.com/manage/preview-servers/overview.md — ok
- netlify dev command (CLI docs): https://github.com/netlify/cli/blob/main/docs/commands/dev.md — ok

