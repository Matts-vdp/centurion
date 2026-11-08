# Centurion

Centurion is a local manager for Claude agents, with a web UI. You run **chats** in one *managing* repository. A chat can start **expert** agents in your other repositories to research or implement something, and it gets notified when they finish. With an orchestration skill, a chat plans work that spans several repos as rounds of parallel tracks, which you approve in the UI. It also asks you questions there that you answer with clicks.

Every agent is a normal Claude Code session (through the Agent SDK) in its own folder, so it uses that folder's `CLAUDE.md`, skills, MCP servers and settings.

## Install

You need Node 20.11 or newer and access to Claude: your Claude Code login, a `CLAUDE_CODE_OAUTH_TOKEN`, or provider variables such as Foundry.

```bash
npm i -g https://github.com/Matts-vdp/centurion/releases/latest/download/centurion.tgz
```

The same command updates an existing install. To install a specific version, use `releases/download/v1.0.1/centurion.tgz` instead of `releases/latest/download/centurion.tgz`.

Without access to GitHub releases, build the package from a clone instead:

```bash
git clone https://github.com/Matts-vdp/centurion && cd centurion
npm ci
npm pack && npm i -g ./centurion-*.tgz
```

## Set up a managing repository

```bash
cd path/to/managing-repo
centurion init        # use --container in a repo that only runs in a dev container
```

This creates `.centurion/`, and never overwrites anything:

- `config.json`: settings for this repo (committed). `centurion config` explains every field.
- `prompts/`: the instructions appended to agents' system prompts, ready to edit (committed). A file here replaces the built-in prompt; delete it to go back.
- `state/`: agents, queues, session IDs and the API token (ignored by git).

Add your orchestration workflow as a skill, for example `.claude/skills/orchestrate/SKILL.md`. [This repo's](.claude/skills/orchestrate/SKILL.md) is an example to start from. `centurion tools` lists the tools a skill can use.

A managing repo runs in one environment (the host or a dev container), because Claude session IDs only exist on the machine that created them.

## Use it

```bash
centurion
```

Open the URL it prints (it includes the token). Start a chat with **+** in the sidebar (it runs in the managing repo unless you pick another folder), then run your skill in it (`/orchestrate …`) or just talk to it. Experts, plans and questions show up in the chat; you can also message any expert directly.

Create scheduled tasks from the **Scheduled** group in the sidebar, or ask a chat to propose one. Each task can start a new chat or message an existing agent. The task page shows upcoming runs and history, with Run now and pause controls.

| Command | What it does |
|---|---|
| `centurion` | Starts Centurion for the managing repo (found from the current folder or a parent). |
| `centurion init [--container]` | Creates `.centurion/`. |
| `centurion config [--json]` | Shows the config in use and explains every field. |
| `centurion api [--json]` | The HTTP API and its events, for integrating other tools. |
| `centurion tools [--json]` | The tools agents get. |
| `centurion help [--agent]` | Usage; `--agent` prints a full guide for an agent that sets up or integrates Centurion. |

`CENTURION_PORT`, `CENTURION_HOST` and `CENTURION_TOKEN` override the config. In a dev container, see [docs/add-devcontainer-support.md](docs/add-devcontainer-support.md).

## Develop

```bash
npm ci                # installs and builds
npm start             # runs the CLI from source; add arguments after --, e.g. npm start -- config
npm run dev           # the manager plus the Vite dev server for the UI
npm run typecheck
npm run check:docs    # fails when a route, config field or tool has no docs
```

To release, run `npm run release -- patch` (or `minor`, `major`, or an exact version like `1.2.0`) on a clean `master` that is in sync with `origin`. It runs the typecheck and `check:docs`, bumps `package.json`, commits, tags `v<version>` and pushes; the release workflow then builds the package and attaches `centurion.tgz` to the GitHub release. If the push fails, the script prints how to finish or undo it. Design notes and plans are in [docs/](docs/) and [CLAUDE.md](CLAUDE.md).

## License

Apache License 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE). Centurion depends on the Claude Agent SDK, which has its own terms; you need your own Claude access to run it.
