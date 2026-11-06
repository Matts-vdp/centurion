# Agent manager

A local manager for Claude agents, replacing a terminal "herder". The user runs **orchestrator** agents in a central project. They start **expert** agents in other repositories to research or implement things, collect the results, and plan features that span several repos. The user wants a modern, visually pleasing UI instead of a TUI. The usual flow: the user explains a problem to an orchestrator, it proposes rounds of parallel **tracks** (experts in other repos, an expert in the central folder, subagents), the user approves or adjusts them in the chat, and the orchestrator collects the results.

**Status:** the backend and the UI v1 (`docs/ui-v1-plan.md`, layout from `docs/ui-research.md`) are done and tested end to end on Windows. The v1 look is being replaced by the design in **`docs/ui-design.md`**, which also adds model and effort switching, track plans and question sets; its implementation plan (last section) lists the steps and their status. After that: the *soon* items in `docs/ui-research.md`. Later: dev container support (`docs/add-devcontainer-support.md`), repo names instead of absolute paths, configurable notifications, file views, and a link to the user's own agentic dev system (running, blocked and queued tasks).

## Layout

- `src/agent.ts`: `AgentRuntime`, one long-lived Agent SDK `query()` per agent (streaming input). Handles the per-agent queue, turn tracking, interrupt and stop, context usage, and closing idle processes.
- `src/manager.ts`: agent registry (a tree: `parentId`), SDK options per agent, routing notifications, restoring state on startup.
- `src/tools.ts`: in-process MCP server `manager`, given to orchestrators only: `create_expert`, `message_expert`, `get_expert_output`, `list_experts`, `stop_expert`, `propose_tracks`, `ask_user`.
- `src/decisions.ts`: helpers for track plans and question sets (validation, the messages Start and Send turn into). The state lives in `Manager` (`plans`, `questionSets`) and in the state file.
- `src/server.ts`: HTTP API (including `/api/models` and `POST /api/agents/:id/model`), server-sent events (`snapshot`, `agent`, `delivered`, `message`, `plan`, `questions`) and the token check. `src/config.ts`: config loading. `src/state.ts`: the JSON state file.
- `ui/`: the web UI (Vite + React + TypeScript, plain CSS with theme variables in `ui/src/styles.css`). `api.ts` (token, fetch, commands), `store.ts` (SSE-fed agent store, per-browser view state in `localStorage`), `timeline.ts` (history + live events → transcript items; sender derived from the prompt prefix), `blocks.ts` (transcript items → turns, work logs, delegations, footers), `status.ts` (an agent's one state and its status line), `models.ts` (the models list, model labels, what an agent runs on), `tools.ts` (tool summaries), components `App`, `Sidebar`, `Switcher`, `AgentView`, `Header`, `ModelPicker`, `Composer`, `Transcript`, `Delegation`, `Plan`, `Questions`, `Mark`. `npm run build` writes `dist/ui`, which `src/server.ts` serves at `/`.
- `prompts/orchestrator.md`, `prompts/expert.md`: instructions appended to the Claude Code system prompt (`{{placeholders}}` are filled in per agent).
- `README.md`: usage, config fields and the API table. Keep it in sync when these change.

## Design decisions (keep unless the user changes them)

- **One message per turn.** The next queued message is sent only after the previous `result` arrives, so every turn maps to exactly one queue entry.
- **Messaging is async only.** `message_expert` never waits. With `notify` (default on), the parent gets a `[Manager notification]` when the turn ends, and reads the reply with `get_expert_output`. Consecutive notifications are combined into one message.
- **Decisions never mix with chat.** Start (plans) and Send (questions) deliver only the structured choice as one message; Enter in the composer sends only what was typed.
- **Handoffs use files.** The orchestrator writes `handoffs/<task>/<expert>.prompt.md` and the expert writes the matching `.findings.md`. Experts get the orchestrator's folder through `additionalDirectories`.
- **State is one JSON file:** the registry, queues, session IDs and the last 20 final replies. Writes go through a temp file and a rename, and only the manager writes it. Transcripts are **not** copied; history comes from `getSessionMessages()` (Claude's own session files).
- **Permissions:** `auto` mode with `permissionPrompts: 'none'`, so anything auto can't decide is denied, never asked. Dev containers will use `bypassPermissions`.
- **Model and effort are per agent and optional.** Unset means `config.model` / Claude Code's default and the model's default effort. Experts created without them take their track's, else their orchestrator's current ones; there is no separate expert default. Changes reach a live process just before its next turn.
- **Folders are absolute paths**, checked on create. Orchestrators all run in the configured `orchestratorFolder` (no folder choice in the UI). An expert's folder defaults to its orchestrator's folder.
- **Interrupt keeps the queue; stop clears it.** An interrupted turn is recorded as "Interrupted by the user." with `interrupted: true`, not as an error. Only experts can be archived, and only when not running; a new message unarchives them.
- **Unread is per browser:** the record has `lastActivityAt`; the UI keeps `lastSeen` in `localStorage`.
- **Restarts and idle processes:** after a restart, an agent that was mid-turn becomes `interrupted` and its parent is notified. Idle processes close after `idleMinutes`, and the next message resumes the same session.

## Working here

- **UI work follows `docs/ui-design.md`**: colour only for state, the transcript as a document, no coloured left borders, tinted role boxes, cards around everything, gradients, emoji or uppercase labels. Theme values live in `ui/src/styles.css`. When a change alters a rule or pattern there, update the guide in the same commit.
- Backend: TypeScript ESM run with `tsx`, no build step. UI: `npm run build` (or `npm run dev` for the Vite dev server with `/api` proxied). Check both with `npm run typecheck`. Line endings are LF (`.gitattributes`).
- Commit each finished part with a short message.
- **Test with a separate config, port and state file** (e.g. in a scratch folder: `npx tsx src/index.ts --config <file>`). Real agents use the user's Claude usage, so keep test prompts tiny.
- When you start the manager from inside Claude Code, remove the parent session's env vars (`CLAUDE*`, `ANTHROPIC_BASE_URL`, etc.) or the agents inherit the host session's settings. Use `env -u ...` or `removeEnv`.
- The UI is checked in the browser pane against the test manager (build first, then open `http://127.0.0.1:<port>/?token=...`). Check light and dark and a narrow width. The file `ui/src/timeline.ts` is not named `transcript.ts` because `Transcript.tsx` exists and Windows file names are case-insensitive.
- On Windows, stopping a background `npx` leaves `node` running. Stop the process that owns the port.

## SDK gotchas

- `total_cost_usd` in `result` is cumulative per `query()` call; `AgentRuntime` adds up per-turn differences.
- `result.usage` adds up every model call of the turn, so it overcounts context after tool calls. Context % uses the last main-loop assistant message's input tokens (plus cache read/write) and `contextWindow` from `modelUsage` (the init message's model).
- `q.interrupt()` ends the turn with its `result` (the process and session stay), and the session writes a `[Request interrupted by user…]` user message into history; the UI shows that as "Interrupted".
- `bypassPermissions` needs `allowDangerouslySkipPermissions: true`, and Claude Code refuses it when running as root.
- A set `ANTHROPIC_API_KEY` takes precedence over the subscription login. Session IDs only exist in the `~/.claude` of the machine that created them.
- Claude Code itself blocks long `sleep` commands.
- `q.setModel()` writes `<command-name>/model…` and `<local-command-stdout>Set model to …` user messages into the session; the UI hides the first and shows the second as an event line. The init message has no effort on SDK processes, so `activeEffort` usually stays null. `supportedModels()` works on a process that has had no prompt yet (no API call), which is how `/api/models` probes when no agent has run.
