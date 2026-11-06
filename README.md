# Agent manager

A local manager for Claude agents. You start **chats** in a central project (the managing folder). A chat always has a small set of tools to start **expert** agents in other folders, and it gets notified when the experts finish. Run `/orchestrate` in a chat to make it an **orchestrator** that plans work as rounds of parallel tracks. A VS Code-style web UI shows every agent in a tree, its live transcript with tool calls collapsed, and a box to message any agent directly.

## Run it (Windows or Linux)

```bash
npm install
cp agent-manager.config.example.json agent-manager.config.json   # then set a token
npm run build
npm start
```

Open the URL it prints (it includes `?token=...`). Start a chat with the **+** button in the sidebar: it only needs a name and, optionally, a first message. Chats all run in `orchestratorFolder` (normally the folder you start the manager from). A chat is a plain Claude Code session; start a message with `/orchestrate` to load the orchestrator workflow from `.claude/skills/orchestrate/SKILL.md`.

Auth comes from your normal Claude Code login (`claude` → `/login`), a `CLAUDE_CODE_OAUTH_TOKEN`, or provider variables such as Foundry. Put provider variables in the config's `env` or in your shell. If `ANTHROPIC_API_KEY` is set, it is used and billed instead of your subscription.

### Scripts

| Script | What it does |
|---|---|
| `npm start` | Runs the manager and serves the built UI from `dist/ui` at `/`. |
| `npm run build` | Builds the UI (`ui/`, Vite + React) into `dist/ui`. |
| `npm run dev` | Runs the manager (restarting on changes) and the Vite dev server together. Open `http://localhost:5173/?token=...`; `/api` is proxied to the manager's port (`AGENT_MANAGER_PORT`, default 4317). Use `AGENT_MANAGER_CONFIG` to pick a config file. |
| `npm run typecheck` | Type-checks the backend and the UI. |

## The UI

- **Sidebar:** each agent has a monogram mark (filled for orchestrators) with its state in the corner: a spinning arc while running, dots for a new reply, queued, failed, interrupted or stopped. Rows have two lines: the name (experts add their folder name) and a status line (`Running Bash · 1m 12s`, `Replied 4 min ago`). **Needs you** lists orchestrators with a plan or questions waiting for you, failed or interrupted agents, and orchestrators with an unread reply. A collapsed orchestrator rolls up its experts ("1 running · 1 failed"). Archived experts sit in an "Archived" group. The footer shows what is running and the total spend.
- **Ctrl+K** (or the search field) jumps to any agent by name, folder or orchestrator.
- **Header:** the breadcrumb as the title (the orchestrator part is a link; **Alt+←** goes there), the model chip (`Sonnet 5.5 ▂▄▆ medium`: the model, bars for the effort level and its name; click it to pick another model or effort, which applies from the next turn), the folder chip (click copies the path), cost, a context ring, and the **⋯** menu with **Archive** / **Unarchive** (experts) and **Stop agent**, which also clears the queue and closes the process. The second line says what the agent is doing.
- **Transcript:** messages into the agent (from you or the orchestrator) sit on a block with who sent it and when; the agent's replies are plain text with markdown and code highlighting. Runs of tool calls fold into one line ("Worked for 18s · ran 3 commands, read 2 files") that opens into the steps, with commands, outputs and diffs. Failed steps open by themselves. **Ctrl+O** opens every step. Each turn ends with a footer: duration, tools and cost, or the error. In an orchestrator, every `create_expert` / `message_expert` is one object with the expert's folder, model and effort, its live state and its reply; the manager notification and `get_expert_output` fold into it. A model switch shows as an event line ("Model switched to Haiku 5.5") where the next turn starts.
- **Track plans:** when an orchestrator proposes tracks, the plan shows in its transcript with a checkbox per track, the later rounds it outlined (folded) and **Start**. Start sends only the checked tracks; anything typed in the composer is a separate chat message. A new version of the plan folds the old one away. After Start, the same object tracks the round: one row per started track with the expert's state and first reply line, and a toggle between one notification per round (default) and one per reply.
- **Question sets:** the orchestrator's questions for you show as one object: options to click (keys 1–4), chips for multiple choice, a free answer for everything, plus the questions it answered itself (with **Correct**) and the ones it sent to an expert in another repo. **Send** delivers only the answers; you can send some and answer the rest later.
- **Composer:** Enter sends, Shift+Enter adds a line. While the agent runs, a status line shows what it is doing, messages queue (listed in the composer, each removable), and **Esc** or the stop button interrupts the current turn and keeps the queue.
- Light and dark themes follow the system setting. Unread state and collapsed tree nodes are kept per browser.

## Config (`agent-manager.config.json`)

| Field | Meaning |
|---|---|
| `host`, `port` | Where the API and UI listen. Keep `127.0.0.1` unless you use plain `docker -p`. |
| `token` | Required on every API call (`Authorization: Bearer` or `?token=`). Empty disables the check, so don't do that with `bypassPermissions`. |
| `stateFile` | JSON state, relative to the config file. Keep one per environment: session IDs only exist on the machine that created them. |
| `orchestratorFolder` | Folder every top-level chat runs in, relative to the config file or absolute. Default (`null` or missing): the folder the manager was started from. Checked at startup. |
| `permissionMode` | `auto` (the classifier decides; what it can't decide is asked in the UI and waits for your answer) or `bypassPermissions` (dev containers). |
| `model` | Default model for agents that have none set (see *Model and effort*), or `null` for the Claude Code default. |
| `env` / `removeEnv` | Environment variables to add to or remove from agent processes. |
| `idleMinutes` | Close an agent's process after this many idle minutes (default 10, `0` = never). The next message resumes the session. |

Use `--config <path>` or `AGENT_MANAGER_CONFIG` to point at another config file. `AGENT_MANAGER_PORT`, `AGENT_MANAGER_HOST` and `AGENT_MANAGER_TOKEN` override the file.

## How it works

- **One agent = one Claude session** (Agent SDK `query()` with streaming input) in its own folder. Each agent has a **queue**, and the manager delivers one message per turn.
- **Chats and orchestrators:** every top-level agent is a chat in `orchestratorFolder` with the `manager` tools; nothing about orchestration is added to its prompt. The `orchestrate` skill (`.claude/skills/orchestrate/SKILL.md` in the managing folder) holds the workflow: rounds of tracks, handoff files, triaging questions. Edit it to change how orchestrators work. Experts get `prompts/expert.md` appended to their system prompt.
- **Settings and skills:** every agent loads the user, project and local settings of its own folder (`settingSources: ['user', 'project', 'local']`, `skills: 'all'`): your `~/.claude`, plus the folder's CLAUDE.md, `.claude/skills` and settings. Chats get the managing folder's, experts their repo's.
- **Manager tools** (MCP server `manager`, top-level chats only):
  `create_expert(name, folder?, message?, notify?, track_id?, model?, effort?)`, `message_expert(expert_id, message, notify?, track_id?, question_id?)`, `get_expert_output(expert_id, last_n?)`, `list_experts()`, `stop_expert(expert_id)`, `propose_tracks(round, title, tracks, later?)`, `ask_user(title, questions, resolved?, routed?)`.
  `folder` defaults to the orchestrator's own folder. `notify` defaults to true. `model` and `effort` default to the track's (with `track_id`), else to the orchestrator's (see below). `list_experts` includes archived experts with `archived: true`.
- **Model and effort:** each agent has an optional `model` (alias such as `sonnet`, or a model id) and `effort` (`low` … `max`). Unset, the model is `config.model` or Claude Code's default, and the effort is the model's default. An expert created without them gets its track's values, else its orchestrator's current ones (what it is set to, else the model it last ran on), so most experts simply run like their orchestrator. An inherited effort the expert's model can't run is dropped; an explicit one is refused. Changing them on a live process (`POST /api/agents/:id/model`) applies before the next turn: a running turn finishes on its model. The values are saved, so a resumed process gets them as `query()` options. `activeModel` on the record is the model of the last main-loop call.
- **Notifications:** when an expert finishes a message sent with `notify`, the orchestrator gets a `[Manager notification]` message with a short preview. Notifications that pile up while the orchestrator is busy are combined into one message. If you interrupt such a turn, the orchestrator is told the expert "was interrupted by the user".
- **Rounds:** `propose_tracks` stores a plan and returns at once; the orchestrator waits for the user. Calling it again for the same round makes a new version. `track_id` ties an expert to its track. With the default round notifications, the replies of a round's tracks are held back and delivered together (with a `Round … : all … started tracks replied.` line) once every started track has replied and either every chosen track was started or the orchestrator is idle.
- **Questions:** `ask_user` stores a question set and returns at once. `question_id` on `message_expert` ties a routed question to the expert's reply, which becomes its answer.
- **Interrupt vs. stop:** interrupt cancels the current turn only; the reply is recorded as "Interrupted by the user." (not an error) and the next queued message follows. Stop also clears the queue and closes the process.
- **Archive:** hides an idle or stopped expert in the tree. Sending it a message unarchives it.
- **Files for handoffs:** the `orchestrate` skill tells the orchestrator to write prompt files and expect findings files in its own folder. Experts get access to the orchestrator's folder through `additionalDirectories`.
- **State:** `stateFile` holds the track plans and question sets, the agent tree, queues, session IDs, the last 20 final replies, the archive flag, the last activity time and the context use per agent. Transcripts are not copied: the UI reads them from Claude's own session files. After a restart, an agent that was mid-turn shows as `interrupted`. Its next message resumes the same session.
- **Context use** is the input size of the last model call of the last turn, divided by the main model's context window.

### API

| Method | Path | Body |
|---|---|---|
| GET | `/api/info` | `{ permissionMode, orchestratorFolder, platform, defaultModel }` |
| GET | `/api/models` | Supported models: `{ value, resolvedModel?, displayName, description, supportsEffort?, supportedEffortLevels? }[]` (cached; learned from the first agent process, or from a process started just to ask) |
| GET | `/api/agents` | |
| POST | `/api/agents` | `{ name, message? }` creates a chat in `orchestratorFolder` |
| GET | `/api/agents/:id` | |
| GET | `/api/agents/:id/history` | Transcript from Claude's session file |
| POST | `/api/agents/:id/messages` | `{ text, notify? }` |
| POST | `/api/agents/:id/interrupt` | Cancels the current turn; keeps the queue and the process |
| DELETE | `/api/agents/:id/queue/:messageId` | Removes a queued message |
| POST | `/api/agents/:id/model` | `{ model?, effort? }`; a missing field stays, `null` goes back to the default. Applies from the next turn |
| POST | `/api/agents/:id/archive` | `{ archived }`; refused while running. A chat takes its idle experts with it, and unarchiving it brings those back. Archiving closes the process; a new message unarchives |
| POST | `/api/agents/:id/permission` | `{ requestId, decision: 'allow' \| 'allowSession' \| 'deny', message? }` answers a waiting permission request. `allowSession` adds the SDK's suggested rules to this session only; `message` goes to the agent with a denial |
| POST | `/api/agents/:id/stop` | Cancels the turn, clears the queue and closes the process |
| GET | `/api/plans` | Track plans |
| POST | `/api/plans/:id/start` | `{ start: trackIds, skip?: trackIds }`; sends the orchestrator only these ids |
| POST | `/api/plans/:id/notify` | `{ mode: 'round' \| 'each' }` |
| GET | `/api/questions` | Question sets |
| POST | `/api/questions/:id/answer` | `{ answers: [{ questionId, choices?, text? }], corrections?: [{ questionId, text }] }` |
| GET | `/api/events` | Server-sent events: `snapshot`, `agent`, `delivered`, `message`, `plan`, `questions`, `permission` (all plans, question sets and permission requests follow each snapshot) |

Agent records carry `model` and `effort` (set, or `null`), `activeModel` and `activeEffort` (what the process last reported; effort is only known when Claude Code reports it), `archived` and `archivedWith` (the chat an expert was archived with), `lastActivityAt` (when a turn last ended or failed), `turnStartedAt` (while a turn runs) and `context: { usedTokens, windowTokens } | null`, besides the queue, replies, status and cost. Each reply has `durationMs` and `costUsd` for its turn.

Permission requests (`permission` events) carry `id`, `agentId`, `toolName`, `toolUseId`, `input`, the SDK's `title`, `description`, `reason` and `blockedPath` when given, `canAllowSession`, `defaultToNo`, `status` (`pending`, `allowed`, `allowedSession`, `denied`, `cancelled`) and the times. They live in memory only: a waiting request is cancelled when the turn is interrupted, stopped or ends, and after a restart the turn is interrupted as usual. `AskUserQuestion` is always denied with a pointer to `ask_user` (chats) or the reply (experts), and `ExitPlanMode` is always allowed.
