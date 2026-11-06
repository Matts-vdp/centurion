# Agent manager

A local manager for Claude agents, replacing a terminal "herder". The user runs **chats** in a central project (the managing folder, where the manager is started); a chat becomes an **orchestrator** when the user runs the `/orchestrate` skill. They start **expert** agents in other repositories to research or implement things, collect the results, and plan features that span several repos. The user wants a modern, visually pleasing UI instead of a TUI. The usual flow: the user explains a problem to an orchestrator, it proposes rounds of parallel **tracks** (experts in other repos, an expert in the central folder, subagents), the user approves or adjusts them in the chat, and the orchestrator collects the results.

**Status:** the backend and the UI v1 (`docs/ui-v1-plan.md`, layout from `docs/ui-research.md`) are done and tested end to end on Windows. The v1 look is being replaced by the design in **`docs/ui-design.md`**, which also adds model and effort switching, track plans and question sets; its implementation plan (last section) lists the steps and their status. Archiving chats, split view and permission prompts (`docs/next-plan.md`) are done, and so are experts from the UI, subagent lines, fork and rewind (`docs/fork-plan.md`). Next: the *soon* items in `docs/ui-research.md`. Later: dev container support (`docs/add-devcontainer-support.md`), repo names instead of absolute paths, configurable notifications, file views, and a link to the user's own agentic dev system (running, blocked and queued tasks).

## Layout

- `src/agent.ts`: `AgentRuntime`, one long-lived Agent SDK `query()` per agent (streaming input). Handles the per-agent queue, turn tracking, interrupt and stop, context usage, and closing idle processes.
- `src/manager.ts`: agent registry (a tree: `parentId`), SDK options per agent, routing notifications, restoring state on startup.
- `src/tools.ts`: in-process MCP server `manager`, given to orchestrators only: `create_expert`, `message_expert`, `get_expert_output`, `list_experts`, `stop_expert`, `propose_tracks`, `ask_user`.
- `src/decisions.ts`: helpers for track plans and question sets (validation, the messages Start and Send turn into). The state lives in `Manager` (`plans`, `questionSets`) and in the state file.
- `src/server.ts`: HTTP API (including `/api/models`, `POST /api/agents/:id/model`, `.../experts`, `.../fork`, `.../rewind` and `GET .../subagents/:toolUseId`), server-sent events (`snapshot`, `agent`, `delivered`, `message`, `plan`, `questions`, `permission`) and the token check. `src/config.ts`: config loading. `src/state.ts`: the JSON state file.
- `ui/`: the web UI (Vite + React + TypeScript, plain CSS with theme variables in `ui/src/styles.css`). `api.ts` (token, fetch, commands), `store.ts` (SSE-fed agent store, per-browser view state in `localStorage`), `timeline.ts` (history + live events → transcript items; sender derived from the prompt prefix), `blocks.ts` (transcript items → turns, work logs, delegations, footers), `status.ts` (an agent's one state and its status line), `models.ts` (the models list, model labels, what an agent runs on), `tools.ts` (tool summaries), `layout.ts` (the one or two panes of the main area, per browser), components `App`, `Sidebar`, `Switcher`, `AgentView`, `Header`, `ModelPicker`, `Composer`, `Transcript`, `Delegation`, `Plan`, `Questions`, `Mark`. Permission requests render in `Transcript.tsx` (`PermissionView`). `npm run build` writes `dist/ui`, which `src/server.ts` serves at `/`.
- `prompts/expert.md`: instructions appended to experts' system prompt (`{{placeholders}}` are filled in per agent).
- `.claude/skills/orchestrate/SKILL.md`: the orchestrator workflow as a skill. Top-level chats get no appended prompt; this repo is also the managing folder, so its CLAUDE.md and skills load in every chat.
- `README.md`: usage, config fields and the API table. Keep it in sync when these change.

## Design decisions (keep unless the user changes them)

- **One message per turn.** The next queued message is sent only after the previous `result` arrives, so every turn maps to exactly one queue entry.
- **Messaging is async only.** `message_expert` never waits. With `notify` (default on), the parent gets a `[Manager notification]` when the turn ends, and reads the reply with `get_expert_output`. Consecutive notifications are combined into one message.
- **Decisions never mix with chat.** Start (plans) and Send (questions) deliver only the structured choice as one message; Enter in the composer sends only what was typed.
- **Handoffs use files.** The orchestrator writes `handoffs/<task>/<expert>.prompt.md` and the expert writes the matching `.findings.md`. Experts get the orchestrator's folder through `additionalDirectories`.
- **State is one JSON file:** the registry, queues, session IDs and the last 20 final replies. Writes go through a temp file and a rename, and only the manager writes it. Transcripts are **not** copied; history comes from `getSessionMessages()` (Claude's own session files).
- **Permissions:** `auto` mode with `permissionPrompts: 'host'` and a `canUseTool` callback: what auto can't decide is asked in the UI and **waits indefinitely**; interrupt, stop or the turn ending cancel it. Experts ask the user directly, not through their orchestrator. "Allow for this session" adds rules with destination `session` only, never to settings files. Requests live in memory (`Manager.permissions`). `AskUserQuestion` is denied (use `ask_user`), `ExitPlanMode` allowed. Dev containers will use `bypassPermissions`.
- **Model and effort are per agent and optional.** Unset means `config.model` / Claude Code's default and the model's default effort. Experts created without them take their track's, else their orchestrator's current ones; there is no separate expert default. Changes reach a live process just before its next turn.
- **Fork and rewind work on Claude's session files.** Fork calls `forkSession` cut at the end of the chosen turn into a new agent; rewind forks cut just before the chosen prompt and switches the agent to that session (the old one stays on disk). Files are never rewound. Cut points are prompt uuids: history has them, and `AgentRuntime` sets a `uuid` on every message it delivers. Plans and question sets stay with the chat that made them; waiting ones from rewound turns become `dropped`.
- **Subagents are lines, not agents.** Agent / Task calls get their own transcript line with the `task_progress` summary (`agentProgressSummaries: true`); the expanded steps come from the live stream or `getSubagentMessages`. Claude Code's background hand-backs and `<task-notification>` prompts fold into that line.
- **Experts the user starts** (`POST .../experts`) don't notify their chat; the user tells the chat to read their output.
- **Every top-level chat is the same:** it always has the `manager` tools, and orchestrating is opt-in through the `orchestrate` skill. Internally the kind is still `orchestrator`; the UI calls it a chat.
- **Agents load their own folder's setup:** `settingSources: ['user', 'project', 'local']`, so CLAUDE.md, skills and settings come from the agent's folder and `~/.claude`.
- **Folders are absolute paths**, checked on create. Chats all run in the configured `orchestratorFolder` (no folder choice in the UI). An expert's folder defaults to its orchestrator's folder.
- **Interrupt keeps the queue; stop clears it.** An interrupted turn is recorded as "Interrupted by the user." with `interrupted: true`, not as an error. Chats and experts can be archived, only when not running; a chat takes its experts with it. Archiving closes the process, and a new message unarchives.
- **Unread is per browser:** the record has `lastActivityAt`; the UI keeps `lastSeen` in `localStorage`.
- **Restarts and idle processes:** after a restart, an agent that was mid-turn becomes `interrupted` and its parent is notified. Idle processes close after `idleMinutes`, and the next message resumes the same session.

## Working here

- **UI work follows `docs/ui-design.md`**: colour only with meaning (state hues, one aqua accent for actions, repo hues on expert marks), the transcript as a document, no coloured left borders, tinted role boxes, cards around everything, gradients, emoji or uppercase labels. Theme values live in `ui/src/styles.css`. When a change alters a rule or pattern there, update the guide in the same commit.
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
