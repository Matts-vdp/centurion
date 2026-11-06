# Agent manager

A local manager for Claude agents. You start **orchestrator** agents in a central project. They start **expert** agents in other folders through a small set of tools, and they get notified when the experts finish. A VS Code-style web UI shows every agent in a tree, its live transcript with tool calls collapsed, and a box to message any agent directly.

## Run it (Windows or Linux)

```bash
npm install
cp agent-manager.config.example.json agent-manager.config.json   # then set a token
npm run build
npm start
```

Open the URL it prints (it includes `?token=...`). Start an orchestrator with the **+** button in the sidebar: it only needs a name and, optionally, a first message. Orchestrators all run in `orchestratorFolder`.

Auth comes from your normal Claude Code login (`claude` → `/login`), a `CLAUDE_CODE_OAUTH_TOKEN`, or provider variables such as Foundry. Put provider variables in the config's `env` or in your shell. If `ANTHROPIC_API_KEY` is set, it is used and billed instead of your subscription.

### Scripts

| Script | What it does |
|---|---|
| `npm start` | Runs the manager and serves the built UI from `dist/ui` at `/`. |
| `npm run build` | Builds the UI (`ui/`, Vite + React) into `dist/ui`. |
| `npm run dev` | Runs the manager (restarting on changes) and the Vite dev server together. Open `http://localhost:5173/?token=...`; `/api` is proxied to the manager's port (`AGENT_MANAGER_PORT`, default 4317). Use `AGENT_MANAGER_CONFIG` to pick a config file. |
| `npm run typecheck` | Type-checks the backend and the UI. |

## The UI

- **Agent tree:** orchestrators with their experts beneath. Each row has a status dot (running, idle, error, stopped, interrupted), a queue count and an unread dot when the agent finished a turn or failed since you last opened it. An orchestrator row rolls up its experts ("1 running · 1 error · 2 new"), so trouble shows even when it is collapsed. Archived experts sit in a collapsed "Archived (n)" group.
- **Breadcrumb:** `orchestrator ▸ expert`, with a "Back to orchestrator" button. `create_expert` and `message_expert` tool cards link to their expert.
- **Transcript:** markdown with code highlighting. Each prompt says who sent it: you, the orchestrator or a manager notification. Tool calls are collapsed cards with a one-line summary and status; errors and denied permissions are highlighted. Thinking and subagent internals are hidden.
- **Message box:** Enter sends, Shift+Enter adds a line. While the agent runs, messages queue (shown above the box, each removable). **Esc** or **Stop** interrupts the current turn and keeps the queue.
- **Header:** status, folder, cost and context use after the last turn. Its **⋯** menu has **Archive** / **Unarchive** (experts) and **Stop agent**, which also clears the queue and closes the process.
- Light and dark themes follow the system setting. Unread state and collapsed tree nodes are kept per browser.

## Config (`agent-manager.config.json`)

| Field | Meaning |
|---|---|
| `host`, `port` | Where the API and UI listen. Keep `127.0.0.1` unless you use plain `docker -p`. |
| `token` | Required on every API call (`Authorization: Bearer` or `?token=`). Empty disables the check, so don't do that with `bypassPermissions`. |
| `stateFile` | JSON state, relative to the config file. Keep one per environment: session IDs only exist on the machine that created them. |
| `orchestratorFolder` | Folder every orchestrator runs in, relative to the config file or absolute. Default (`null` or missing): the folder the manager was started from. Checked at startup. |
| `permissionMode` | `auto` (classifier decides; what it can't decide is denied, not asked) or `bypassPermissions` (dev containers). |
| `model` | Model for every agent, or `null` for the Claude Code default. |
| `env` / `removeEnv` | Environment variables to add to or remove from agent processes. |
| `idleMinutes` | Close an agent's process after this many idle minutes (default 10, `0` = never). The next message resumes the session. |

Use `--config <path>` or `AGENT_MANAGER_CONFIG` to point at another config file. `AGENT_MANAGER_PORT`, `AGENT_MANAGER_HOST` and `AGENT_MANAGER_TOKEN` override the file.

## How it works

- **One agent = one Claude session** (Agent SDK `query()` with streaming input) in its own folder. Each agent has a **queue**, and the manager delivers one message per turn.
- **Orchestrator tools** (MCP server `manager`, orchestrators only):
  `create_expert(name, folder?, message?, notify?)`, `message_expert(expert_id, message, notify?)`, `get_expert_output(expert_id, last_n?)`, `list_experts()`, `stop_expert(expert_id)`.
  `folder` defaults to the orchestrator's own folder. `notify` defaults to true. `list_experts` includes archived experts with `archived: true`.
- **Notifications:** when an expert finishes a message sent with `notify`, the orchestrator gets a `[Manager notification]` message with a short preview. Notifications that pile up while the orchestrator is busy are combined into one message. If you interrupt such a turn, the orchestrator is told the expert "was interrupted by the user".
- **Interrupt vs. stop:** interrupt cancels the current turn only; the reply is recorded as "Interrupted by the user." (not an error) and the next queued message follows. Stop also clears the queue and closes the process.
- **Archive:** hides an idle or stopped expert in the tree. Sending it a message unarchives it.
- **Files for handoffs:** the instructions in `prompts/orchestrator.md` tell it to write prompt files and expect findings files in its own folder. Experts get access to the orchestrator's folder through `additionalDirectories`. Edit the files in `prompts/` to change the instructions.
- **State:** `stateFile` holds the agent tree, queues, session IDs, the last 20 final replies, the archive flag, the last activity time and the context use per agent. Transcripts are not copied: the UI reads them from Claude's own session files. After a restart, an agent that was mid-turn shows as `interrupted`. Its next message resumes the same session.
- **Context use** is the input size of the last model call of the last turn, divided by the main model's context window.

### API

| Method | Path | Body |
|---|---|---|
| GET | `/api/info` | `{ permissionMode, orchestratorFolder, platform }` |
| GET | `/api/agents` | |
| POST | `/api/agents` | `{ name, message? }` creates an orchestrator in `orchestratorFolder` |
| GET | `/api/agents/:id` | |
| GET | `/api/agents/:id/history` | Transcript from Claude's session file |
| POST | `/api/agents/:id/messages` | `{ text, notify? }` |
| POST | `/api/agents/:id/interrupt` | Cancels the current turn; keeps the queue and the process |
| DELETE | `/api/agents/:id/queue/:messageId` | Removes a queued message |
| POST | `/api/agents/:id/archive` | `{ archived }`; experts only, refused while running |
| POST | `/api/agents/:id/stop` | Cancels the turn, clears the queue and closes the process |
| GET | `/api/events` | Server-sent events: `snapshot`, `agent`, `delivered`, `message` |

Agent records carry `archived`, `lastActivityAt` (when a turn last ended or failed), `turnStartedAt` (while a turn runs) and `context: { usedTokens, windowTokens } | null`, besides the queue, replies, status and cost. Each reply has `durationMs` and `costUsd` for its turn.
