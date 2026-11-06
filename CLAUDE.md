# Agent manager

A local manager for Claude agents, replacing a terminal "herder". The user runs **orchestrator** agents in a central project. They start **expert** agents in other repositories to research or implement things, collect the results, and plan features that span several repos. The user wants a VS Code-like UI instead of a TUI.

**Status:** the backend plus a bare test page (`public/index.html`) are done and tested on Windows. **Now: designing the real UI** (research goes in `docs/ui-research.md`). Later: dev container support (`docs/add-devcontainer-support.md`), repo names instead of absolute paths, configurable notifications, file views, and a link to the user's own agentic dev system (running, blocked and queued tasks).

## Layout

- `src/agent.ts`: `AgentRuntime`, one long-lived Agent SDK `query()` per agent (streaming input). Handles the per-agent queue, turn tracking, stop, and closing idle processes.
- `src/manager.ts`: agent registry (a tree: `parentId`), SDK options per agent, routing notifications, restoring state on startup.
- `src/tools.ts`: in-process MCP server `manager`, given to orchestrators only: `create_expert`, `message_expert`, `get_expert_output`, `list_experts`, `stop_expert`.
- `src/server.ts`: HTTP API, server-sent events (`snapshot`, `agent`, `delivered`, `message`) and the token check. `src/config.ts`: config loading. `src/state.ts`: the JSON state file.
- `prompts/orchestrator.md`, `prompts/expert.md`: instructions appended to the Claude Code system prompt (`{{placeholders}}` are filled in per agent).
- `README.md`: usage, config fields and the API table. Keep it in sync when these change.

## Design decisions (keep unless the user changes them)

- **One message per turn.** The next queued message is sent only after the previous `result` arrives, so every turn maps to exactly one queue entry.
- **Messaging is async only.** `message_expert` never waits. With `notify` (default on), the parent gets a `[Manager notification]` when the turn ends, and reads the reply with `get_expert_output`. Consecutive notifications are combined into one message.
- **Handoffs use files.** The orchestrator writes `handoffs/<task>/<expert>.prompt.md` and the expert writes the matching `.findings.md`. Experts get the orchestrator's folder through `additionalDirectories`.
- **State is one JSON file:** the registry, queues, session IDs and the last 20 final replies. Writes go through a temp file and a rename, and only the manager writes it. Transcripts are **not** copied; history comes from `getSessionMessages()` (Claude's own session files).
- **Permissions:** `auto` mode with `permissionPrompts: 'none'`, so anything auto can't decide is denied, never asked. Dev containers will use `bypassPermissions`.
- **Folders are absolute paths**, checked on create. An expert's folder defaults to its orchestrator's folder.
- **Restarts and idle processes:** after a restart, an agent that was mid-turn becomes `interrupted` and its parent is notified. Idle processes close after `idleMinutes`, and the next message resumes the same session.

## Working here

- TypeScript ESM run with `tsx`, no build step. Check with `npm run typecheck`. Line endings are LF (`.gitattributes`).
- Commit each finished part with a short message.
- **Test with a separate config, port and state file** (e.g. in a scratch folder: `npx tsx src/index.ts --config <file>`). Real agents use the user's Claude usage, so keep test prompts tiny.
- When you start the manager from inside Claude Code, remove the parent session's env vars (`CLAUDE*`, `ANTHROPIC_BASE_URL`, etc.) or the agents inherit the host session's settings. Use `env -u ...` or `removeEnv`.
- On Windows, stopping a background `npx` leaves `node` running. Stop the process that owns the port.

## SDK gotchas

- `total_cost_usd` in `result` is cumulative per `query()` call; `AgentRuntime` adds up per-turn differences.
- `bypassPermissions` needs `allowDangerouslySkipPermissions: true`, and Claude Code refuses it when running as root.
- A set `ANTHROPIC_API_KEY` takes precedence over the subscription login. Session IDs only exist in the `~/.claude` of the machine that created them.
- Claude Code itself blocks long `sleep` commands.
