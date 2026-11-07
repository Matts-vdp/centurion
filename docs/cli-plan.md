# CLI plan

Goal: run the manager with one command in any managing repo: a personal one at home (on Windows), the work repo (in its dev container) at work. The manager is a public open-source project on the user's GitHub. A managing repo installs it and keeps only its own setup; no manager source is copied in.

Work uses the project like any third-party tool, pinned to a version. Work-specific setup (the orchestration skill, prompts, MCP servers, later the dashboard integration) lives in the work repo and never flows back. Changes to the core are made in the public repo only.

The project is called **Centurion**: the bin is `centurion`, the repo folder `.centurion/`, the env vars `CENTURION_*`, and the tool server `centurion` (tools are `mcp__centurion__create_expert` and so on). `centurion` is taken on npm, which doesn't matter while nothing is published there.

## Decisions

- **Public on GitHub, no registry.** Apache-2.0 license. Installed from the repo, pinned to a tag. Nothing is published to npm. See *Install* below.
- **The managing repo owns orchestration.** The package ships no orchestration skill and `init` writes none. Each managing repo has its own (the work repo already does; it moves from the herder commands to the manager's tools). The tools describe themselves, so a skill only needs to say how to use them. This repo keeps its `.claude/skills/orchestrate/` for its own use and as an example.
- **Prompts are replaced, not extended.** A file in `.centurion/prompts/` replaces the packaged prompt of that kind as a whole: `expert.md` for experts, `orchestrator.md` for chats (the package ships none for chats, so there it just adds one). A copied prompt no longer follows the package's changes; the release notes say when a prompt changed. Placeholders (`{{id}}`, `{{name}}`, `{{cwd}}`, `{{orchestratorName}}`, `{{orchestratorCwd}}`) are filled in either way. A repo decides where prompts and findings go and which templates they follow; the manager never creates or reads those files.
- **`.centurion/` is the manager's one home in a repo:**
  - `config.json`: settings for the repo (permission mode, model, port, idle minutes). **Committed**, so no secrets in it.
  - `prompts/`: prompt replacements, if any. **Committed.**
  - `state/`: `state.json`, `uploads/` and `token`. **Ignored.**
- **The token is not config.** It is generated into `state/token` on first start and printed with the URL. `CENTURION_TOKEN` overrides it.
- **One environment per managing repo.** A managing repo runs either only in its dev container or only on the host (Windows at home), never both, so its state, session IDs and config belong to that one environment. No per-machine naming or local config layer. Auth and other personal values (`CLAUDE_CODE_OAUTH_TOKEN`, provider variables) come from the environment, not from the committed config.
- **`orchestratorFolder` defaults to the managing folder**: the folder holding `.centurion/`, found from the current folder or a parent.
- **The host session's env is stripped by default.** Starting the manager from inside a Claude Code session is common, so when `CLAUDECODE` is set, `CLAUDE*`, `ANTHROPIC_BASE_URL` and the MCP connection variables are removed for agents (`src/env.ts`). Auth and provider variables (`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_*`, `CLAUDE_CONFIG_DIR`) stay. `stripHostEnv: false` turns it off; `env` puts a variable back.
- **State has a version and migrations.** `STATE_VERSION` and `MIGRATIONS` in `src/state.ts`: a newer Centurion migrates older files on load, and an older one refuses a newer file at startup instead of overwriting it.

## Install

The package must work without a registry, straight from GitHub:

- **From the repo (default).** `npm i -g github:<user>/<repo>#v0.1.0`. A `prepare` script runs the build (server and UI) during the install, so the repo holds no built files. Installs are rare (a new machine, a container rebuild, an upgrade), so the extra minute and the dev dependencies it downloads don't matter. Needs `git` and access to GitHub.
- **From a clone.** `git clone`, `npm ci`, `npm run build`, then `npm i -g .` (or `npm pack` and install the tarball). For hacking on the core, or when the work network blocks GitHub: build the tarball elsewhere and keep it in the work repo or container image.

A release Action that attaches a built tarball to each tag can come later if installs get slow or GitHub is blocked.

## Commands

- `centurion`: starts the manager for the current folder and prints the URL with the token. Fails with a hint when `.centurion/` is missing.
- `centurion init [--container]`: creates `.centurion/` with a basic `config.json`, the packaged prompts in `prompts/` (as the active prompts, ready to edit; deleting one goes back to the packaged default) and a `.gitignore` inside it (`state/`), so the repo's own `.gitignore` is untouched. `--container` writes `permissionMode: "bypassPermissions"` (the host stays `127.0.0.1`, which VS Code port forwarding needs); without it the mode is `auto`, because `bypassPermissions` outside a container lets agents do anything on the machine. Never overwrites. Everything else is tweaked by hand afterwards.
- `centurion --version`, and the version in `/api/info`.
- The old layout, a `centurion.config.json` in the folder the command runs in, still loads, with a note at start-up.

## Self-description

The CLI explains itself, so the user or an agent can set the manager up, change a repo's setup or integrate it with something else without reading the source. Every command prints plain text (Markdown) by default and JSON with `--json`, and works without a running manager.

- `centurion help`: short usage for people: the commands and their flags.
- `centurion help --agent`: a guide written for an agent, in one go: what the manager is (chats, experts, tracks, decisions), the `.centurion/` layout and what is committed, every config field with its type, default and meaning, prompt replacement and its placeholders, which agent gets which tools, what an agent's folder already controls (CLAUDE.md, skills, `.mcp.json`, hooks), and how to integrate (API, events, deep links). It ends with pointers to the other commands.
- `centurion api`: every HTTP endpoint (method, path, body, result, one line of what it does), the SSE events and their payloads, auth (the token header or `?token=`), and the deep link format (`/#agent=<id>`). `--json` gives the same as data; an OpenAPI file can come later if something needs it.
- `centurion tools`: the tools each kind of agent gets (`centurion`, `display`), with their descriptions and arguments. Useful when writing an orchestration skill that uses them.
- `centurion config`: the resolved config for the current folder (defaults, file, env overrides; the token hidden) and where each value came from. Mainly for debugging a setup.
- The running manager serves the same docs at `GET /api/docs` (`?format=json`), so a client can check what the version it talks to offers.

**One source, no hand-written copies.** The text comes from the code, so it can't drift:
- Endpoints: `src/server.ts` moves from its `if` chain to a route table (method, path pattern, summary, body and result description, handler). The server dispatches from the table, and `api` prints it.
- Config: a zod schema with `.describe()` per field. It also validates `config.json` on start (unknown or wrong fields fail with a clear message), and gives `init` its defaults.
- Tools: their zod schemas and descriptions already exist in `src/tools.ts` and `src/display.ts`; `tools` prints them. Building the tool list needs no running agent.
- The guide's prose is one packaged Markdown file with markers that the generated parts fill in (config table, endpoints, tools, placeholders).

The README links to these commands instead of repeating the API table, and `npm run check:docs` fails when a route, config field or tool has no docs. The code: `src/docs.ts` (rendering), `src/cli.ts` (commands), `guide/agent.md` (the guide's prose).

## Code changes

- **Build.** Compile `src/` to `dist/server` with `tsc -p tsconfig.build.json`. Ship `dist/`, `prompts/` and `guide/` through the `files` field. `engines: node >= 20.11` (`import.meta.dirname`).
- **Package.** `bin`, `files`, `license`, `repository`. `"private": true` can stay (it only blocks `npm publish`).
- **Paths.** `prompts/` and `dist/ui` resolve from the package (`import.meta.dirname`). Config and state resolve from `.centurion/` in the current folder. The `--config` flag stays for development and tests.
- **Config.** Defaults, then `.centurion/config.json`, then the `CENTURION_*` variables.
- **Prompt loading.** `.centurion/prompts/<kind>.md` if present, else the packaged one.
- **Uploads and token** under `state/`.
- **README.** Install, `init`, the `.centurion/` layout, prompt replacement, what is committed and what is ignored.

## Container

- `postCreateCommand`: `npm i -g github:<user>/<repo>#<tag>`, then `centurion init --container` if `.centurion/config.json` doesn't exist (normally it is committed). The version is pinned in the container config, so upgrading is a reviewed change.
- `forwardPorts: [4317]`, `remoteUser: node`, and the `~/.claude` volume as in `docs/add-devcontainer-support.md`.
- Auth as in that doc: `CLAUDE_CODE_OAUTH_TOKEN` through `remoteEnv`, or `/login` once into the `~/.claude` volume. A provider (Foundry, Bedrock) through its environment variables.
- `safe.directory` for each mounted repo, so the Files panel shows git state.

## Open questions

- **Repo names.** A `repos` map in `config.json` (name to path) would let skills and prompts say `backend` instead of an absolute path. This is the "repo names instead of absolute paths" item.
- **Extra MCP servers per role.** `mcpServers: { orchestrator: {...}, expert: {...} }` in config, for work tools only chats or experts should get (for example pushing tasks to the implementation system). A repo's `.mcp.json` already covers servers every agent in that folder gets.
- **Front-end integration** with the work dashboard: later, probably embedding first. See `docs/integration-plan.md`.

## Steps

| # | Step | Status |
|---|------|--------|
| 1 | License, package metadata, `files`, `engines`, `bin` | done |
| 2 | Build `src/` to `dist/server`, ship `dist/ui`, `prompts/` and `guide/` | done |
| 3 | Paths from the package; config and state from `.centurion/` | done |
| 4 | Prompt replacement from `.centurion/prompts/` | done |
| 5 | Token generated into `state/token`; uploads under `state/` | done |
| 6 | `init [--container]` (config, prompts, ignore file), `--version` | done |
| 7 | Default `removeEnv`; state migrations and the newer-file check | done |
| 8 | `prepare` script so a GitHub install builds itself | done |
| 9 | Route table in `src/server.ts`, config as a zod schema | done |
| 10 | `help`, `help --agent`, `api`, `tools`, `config` (text and `--json`), `GET /api/docs` | done |
| 11 | README and `docs/add-devcontainer-support.md` | done |
| 12 | Make the repo public and tag the first release (after the user confirms) | todo (user) |
| 13 | Container setup using the CLI | todo (in the work repo) |
