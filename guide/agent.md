# Centurion {{version}}: guide for agents

Centurion is a local manager for Claude agents with a web UI. The user runs **chats** in one **managing folder** (the repo where Centurion is started). A chat can start **experts**: Claude Code sessions in other repositories (or in the managing folder) that research or implement something and report back. A chat that coordinates experts is an **orchestrator**; it plans work as rounds of parallel **tracks** that the user approves in the UI, and asks the user structured questions. Every agent is a normal Claude Code session run through the Agent SDK, so it loads its own folder's setup: `CLAUDE.md`, skills, `.mcp.json`, hooks and settings, plus `~/.claude`.

Use this guide to set Centurion up in a repo, change how its agents behave, or integrate it with another tool.

## Commands

{{commands}}

`centurion` finds its config by looking for `{{home}}/config.json` in the current folder, then its parents.

## A managing folder

```
<managing folder>/
  {{home}}/
    config.json      settings for this repo (committed; no secrets)
    prompts/         prompt replacements (committed)
    .gitignore       ignores state/
    state/           state.json, uploads/, token (ignored; one environment only)
  .claude/skills/    the repo's own skills, e.g. its orchestration workflow
  CLAUDE.md          loaded by every chat
```

- `centurion init` creates `{{home}}/` with a basic config, the packaged prompts and the ignore file. It never overwrites.
- A managing folder runs in one environment (a dev container, or the host), so its state and session IDs belong there. Session IDs only exist in the `~/.claude` of the machine that created them.
- The API token: set `CENTURION_TOKEN`, or leave `token` empty and Centurion generates one into `{{home}}/state/token` on first start. The start-up line prints the URL with it.

## Config (`{{home}}/config.json`)

Relative paths resolve against the config file's folder. `CENTURION_PORT`, `CENTURION_HOST` and `CENTURION_TOKEN` override the file. Unknown fields and wrong types stop the start with a message. `centurion config` shows the resolved values and where each came from.

{{config}}

## Changing how agents behave

In order of preference:

1. **The agent's folder.** Experts load their own repo's `CLAUDE.md`, skills, `.mcp.json` and settings; chats load their folder's, which is the managing folder unless the user picked another one. Most changes belong there and need nothing from Centurion.
2. **Skills in the managing folder.** Orchestration is a skill the repo owns (for example `.claude/skills/orchestrate/SKILL.md`, run as `/orchestrate`). Centurion ships none. A skill says how to use the tools below: how to split work into tracks, where task and findings files go, which templates they follow.
3. **Prompt files** in `{{home}}/prompts/`. A file replaces the packaged prompt of that kind as a whole, and is appended to Claude Code's system prompt. A chat in another folder, and its experts, use that folder's `.centurion/prompts/<kind>.md` instead, else the packaged prompt (the managing folder's files don't apply there). Delete a file to go back to the packaged default; a copied prompt does not follow later package changes.

Prompt kinds:

{{prompts}}

Placeholders, filled in per agent:

{{placeholders}}

Centurion itself never creates, reads or names task files: where prompts and findings go is up to the repo's skill and prompts.

## Tools agents get

{{tools}}

`centurion tools` prints every tool with its full description and arguments. The tools are fixed by Centurion; prompts and skills decide how they are used.

## Permissions

`permissionMode` applies to every agent. With `auto`, what the classifier can't decide is asked in the UI and waits for the user. In a dev container, `bypassPermissions` avoids prompts (Claude Code refuses it as root). Experts ask the user directly, not through their chat.

## Integrating

- **HTTP API and events.** `centurion api` lists every endpoint, the server-sent events and auth; a running server serves the same at `GET /api/docs` (`?format=json` for data). The token goes in `Authorization: Bearer <token>` or `?token=`.
- **Deep links.** `http://<host>:<port>/?token=<token>#agent=<id>` opens the UI on one agent.
- **Tools of your own.** Give agents an MCP server through the folder's `.mcp.json` (every agent in that folder gets it), for example one that pushes tasks to another system.
- **Auth and providers.** Agents use the normal Claude Code login, `CLAUDE_CODE_OAUTH_TOKEN`, or provider variables (Foundry, Bedrock, Vertex) from the environment or the config's `env`. A set `ANTHROPIC_API_KEY` wins over the subscription login.
- **Running inside Claude Code.** When Centurion is started from a Claude Code session, that session's variables are removed for agents (`stripHostEnv`).
