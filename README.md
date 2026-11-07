# Centurion

A local manager for Claude agents. You start **chats** in a central project (the managing folder). A chat always has a small set of tools to start **expert** agents in other folders, and it gets notified when the experts finish. Run `/orchestrate` in a chat to make it an **orchestrator** that plans work as rounds of parallel tracks. A VS Code-style web UI shows every agent in a tree, its live transcript with tool calls collapsed, and a box to message any agent directly.

## Install

Centurion is installed from GitHub as the `centurion` command; you need Node 20.11 or newer. Each version tag has a built package on its GitHub release:

```bash
npm i -g https://github.com/Matts-vdp/centurion/releases/download/v0.1.0/centurion.tgz
```

Pin the version so an upgrade is a deliberate change. Without access to GitHub releases (a work network, say), build the same file from a clone and install it, or keep it in the repo or container image that needs it:

```bash
git clone --branch v0.1.0 https://github.com/Matts-vdp/centurion && cd centurion
npm ci                                   # also builds (prepare)
npm pack && npm i -g ./centurion-0.1.0.tgz
```

`npm i -g github:...` does not work: npm builds a git package in a temporary clone without its build tools when installing globally.

## Set up a managing folder

The managing folder is the repo your chats run in: it holds the orchestration skill, the CLAUDE.md every chat loads, and Centurion's own folder.

```bash
cd path/to/managing-repo
centurion init              # or: centurion init --container, in a repo that only runs in a dev container
centurion
```

`init` creates `.centurion/` and never overwrites a file:

| Path | What it is | Git |
|---|---|---|
| `.centurion/config.json` | Settings for this repo (see `centurion config`) | committed |
| `.centurion/prompts/` | The prompts Centurion appends for each kind of agent, copied from the package so you can edit them. A file here replaces the packaged prompt; delete it to go back to the default | committed |
| `.centurion/.gitignore` | Ignores `state/` | committed |
| `.centurion/state/` | `state.json` (registry, queues, session IDs), `uploads/`, and the generated API `token` | ignored |

`centurion` (or `centurion start`) finds `.centurion/config.json` in the current folder or a parent, and prints the URL with the token. Open it, start a chat with **+** in the sidebar, and run your orchestration skill in it (for example `/orchestrate`). Centurion ships no skill: the managing repo owns its workflow. This repository's `.claude/skills/orchestrate/SKILL.md` is an example.

A managing folder runs in one environment, a dev container or the host, because session IDs only exist in the `~/.claude` of the machine that created them.

Auth comes from your normal Claude Code login (`claude` → `/login`), a `CLAUDE_CODE_OAUTH_TOKEN`, or provider variables such as Foundry. Put provider variables in your shell or the config's `env`. If `ANTHROPIC_API_KEY` is set, it is used and billed instead of your subscription. Started from inside a Claude Code session, Centurion removes that session's variables for its agents (`stripHostEnv`).

### Commands

The CLI describes itself, for you and for agents that set it up or integrate with it. Everything below is generated from the code.

| Command | What it does |
|---|---|
| `centurion` / `centurion start` | Starts the manager for the managing folder. |
| `centurion init [--container]` | Creates `.centurion/` (above). `--container` sets `permissionMode: "bypassPermissions"`. |
| `centurion config [--json]` | The resolved config, where each value came from, the files in use, and every field with its default and meaning. |
| `centurion api [--json]` | Every HTTP endpoint, the server-sent events, auth and deep links. A running server serves the same at `GET /api/docs`. |
| `centurion tools [--json]` | The tools agents get, with their arguments. |
| `centurion help [--agent]` | Usage; with `--agent`, a full guide for an agent that sets up, changes or integrates Centurion. |
| `centurion --version` | The version (also in `GET /api/info`). |

`--config <file>` (or `CENTURION_CONFIG`) uses another config file. `CENTURION_PORT`, `CENTURION_HOST` and `CENTURION_TOKEN` override the file; `CENTURION_TOKEN=` (empty) turns the token check off.

## Develop

```bash
npm install        # also builds (the prepare script)
npm start          # runs src/cli.ts with tsx; finds .centurion/config.json like the installed command
```

| Script | What it does |
|---|---|
| `npm start` | Runs the CLI from source (`tsx src/cli.ts`); add arguments after `--`, e.g. `npm start -- config`. |
| `npm run build` | Builds the UI (`ui/`, Vite + React) into `dist/ui` and the server (`src/`) into `dist/server`. |
| `npm run dev` | Runs the manager (restarting on changes) and the Vite dev server together. Open `http://localhost:5173/?token=...`; `/api` is proxied to the manager's port (`CENTURION_PORT`, default 4317). |
| `npm run typecheck` | Type-checks the backend and the UI. |
| `npm run check:docs` | Fails when a route, config field or tool has no docs. |

Releasing: set the version in `package.json`, commit, and push a tag `v<version>`. The *Release* workflow (`.github/workflows/release.yml`) checks that the tag matches, type-checks, builds and attaches `centurion.tgz` to a GitHub release.

A `centurion.config.json` in the folder you start from still works (the layout before `.centurion/`), with a note at start-up.

## The UI

- **Sidebar:** each agent has a monogram mark (filled for orchestrators) with its state in the corner: a spinning arc while running, dots for a new reply, queued, failed, interrupted or stopped. Rows have two lines: the name (experts add their folder name) and a status line (`Running Bash · 1m 12s`, `Replied 4 min ago`). **Needs you** lists orchestrators with a plan or questions waiting for you, failed or interrupted agents, and orchestrators with an unread reply. A collapsed orchestrator rolls up its experts ("1 running · 1 failed"). Archived experts sit in an "Archived" group. The footer shows what is running and the total spend.
- **Ctrl+K** (or the search field) jumps to any agent by name, folder or orchestrator.
- **Header:** the breadcrumb as the title (the orchestrator part is a link; **Alt+←** goes there), the model chip (`Sonnet 5.5 ▂▄▆ medium`: the model, bars for the effort level and its name; click it to pick another model or effort, which applies from the next turn), the folder chip (click opens the **Files** panel, **Ctrl+B** too), cost, a context ring, the cache tag (how long the prompt cache stays warm; click it for **keep-warm**, see below), and the **⋯** menu with **Pause expert notifications** / **Resume** (chats, see below), **Copy folder path**, **Archive** / **Unarchive** (experts) and **Stop agent**, which also clears the queue and closes the process. The second line says what the agent is doing.
- **Transcript:** messages into the agent (from you or the orchestrator) sit on a block with who sent it and when; the agent's replies are plain text with markdown and code highlighting; ` ```mermaid ` blocks become diagrams, and `show_visual` calls become visuals (flows, options, hypotheses with evidence, trees, timelines, key numbers, bars) in place. Runs of tool calls fold into one line ("Worked for 18s · ran 3 commands, read 2 files") that opens into the steps, with commands, outputs and diffs. Failed steps open by themselves. **Ctrl+O** opens every step. Each turn ends with a footer: duration, tools and cost, or the error. In an orchestrator, every `create_expert` / `message_expert` is one object with the expert's folder, model and effort, its live state and its reply; the manager notification and `get_expert_output` fold into it. A delegation that starts a plan track is one line with a link to the round tracker, which shows its progress. A model switch shows as an event line ("Model switched to Haiku 5.5") where the next turn starts.
- **Files:** a read-only panel on the right of each pane: the agent's folder as a tree (an expert also gets its orchestrator's folder as a *shared folder*), with git letters on changed files (`M`, `A`, `D`, `R`, `U` untracked, `C` conflict), git-ignored entries dimmed and listed last, and a filter (**Ctrl+P** in the panel). Click a file to read it (highlighted; Markdown rendered with a Source toggle; images shown); **Changes** lists what git sees against `HEAD` with line counts and opens diffs. File paths in Read, Edit and Write steps open the file or its diff there. It refreshes after the agent's edits and Bash calls, at the end of each turn and when the window gets focus. Folders that aren't git repositories just have no Changes tab. Narrow panes show it over the transcript.
- **Track plans:** when an orchestrator proposes tracks, the plan shows in its transcript with a checkbox per track, the later rounds it outlined (folded) and **Start**. Start sends only the checked tracks; anything typed in the composer is a separate chat message. A new version of the plan folds the old one away. After Start, the same object tracks the round: one row per started track with the expert's state and first reply line, and a toggle between one notification per round (default) and one per reply.
- **Question sets:** the orchestrator's questions for you show as one object: options to click (keys 1–4), chips for multiple choice, a free answer for everything, plus the questions it answered itself (with **Correct**) and the ones it sent to an expert in another repo. **Send** delivers only the answers; you can send some and answer the rest later. Writing in the chat instead sets the open questions aside: they fold to one line (*answered in the chat*) and no longer count as waiting, but can still be opened and answered.
- **Composer:** Enter sends, Shift+Enter adds a line. While the agent runs, a status line shows what it is doing, messages queue (listed in the composer, each removable), and **Esc** or the stop button interrupts the current turn and keeps the queue.
- Light and dark themes follow the system setting. Unread state and collapsed tree nodes are kept per browser.

## Config (`.centurion/config.json`)

`centurion config` lists every field with its type, default and meaning, and shows the values in use and where each came from. The most common ones: `port`, `permissionMode` (`auto`, or `bypassPermissions` in a dev container), `model` (the default for agents that have none set, see *Model and effort*), `env` / `removeEnv` (variables for agent processes) and `idleMinutes`. Relative paths resolve against the config file's folder. Leave `token` out of a committed config: the token is then generated into `.centurion/state/token` on first start.

The file is checked at startup: an unknown field or a wrong type stops the manager with a message naming the field and the file.

## How it works

- **One agent = one Claude session** (Agent SDK `query()` with streaming input) in its own folder. Each agent has a **queue**, and the manager delivers one message per turn.
- **Chats and orchestrators:** every top-level agent is a chat in `orchestratorFolder` with the `centurion` tools; nothing about orchestration is added to its prompt unless the repo adds `.centurion/prompts/orchestrator.md`. The managing repo's own skill (here `.claude/skills/orchestrate/SKILL.md`) holds the workflow: rounds of tracks, handoff files, triaging questions. Experts get the expert prompt appended to their system prompt: `.centurion/prompts/expert.md`, else the packaged `prompts/expert.md`. Placeholders such as `{{cwd}}` and `{{orchestratorCwd}}` are filled in per agent (`centurion help --agent` lists them).
- **Settings and skills:** every agent loads the user, project and local settings of its own folder (`settingSources: ['user', 'project', 'local']`, `skills: 'all'`): your `~/.claude`, plus the folder's CLAUDE.md, `.claude/skills` and settings. Chats get the managing folder's, experts their repo's.
- **Centurion tools** (MCP server `centurion`, top-level chats only):
  `create_expert(name, folder?, message?, notify?, track_id?, model?, effort?)`, `message_expert(expert_id, message, notify?, track_id?, question_id?)`, `get_expert_output(expert_id, last_n?)`, `list_experts()`, `stop_expert(expert_id)`, `propose_tracks(round, title, tracks, later?)`, `ask_user(title, questions, resolved?, routed?)`.
  `folder` defaults to the orchestrator's own folder. `notify` defaults to true. `model` and `effort` default to the track's (with `track_id`), else to the orchestrator's (see below). `list_experts` includes archived experts with `archived: true`.
- **Visuals** (MCP server `display`, every agent): `show_visual(title?, markup)` shows a small visual in the transcript: boxes (`Row`, `Column`, `Card` with `title`, `icon`, `tone`, `badge`, `meta`, `value`, `change`, `progress`, `repo`, `link`, `arrow`, and the `arrows` flag), lines (`Tree` and `Timeline` with `Item`), collapsed details (`More`), code excerpts (`Code` with `file`, `line`, `mark`, `lang`), `Bars` and `Image`. The markup is parsed by `src/visual.ts` (limits, the icon list); errors, unknown experts in `expert:` links and missing files in `file:` links, `Code` and `Image` go back to the agent, which tries again, and a `Code` excerpt that doesn't match its file gets a warning. `file:path:42` links open the Files panel at that line. The tool description is the whole guide, so no prompt mentions it. The UI draws the markup with its own components. Bigger diagrams go in ` ```mermaid ` blocks in replies, which the UI renders too. See `docs/visuals-research.md`.
- **Model and effort:** each agent has an optional `model` (alias such as `sonnet`, or a model id) and `effort` (`low` … `max`). Unset, the model is `config.model` or Claude Code's default, and the effort is the model's default. An expert created without them gets its track's values, else its orchestrator's current ones (what it is set to, else the model it last ran on), so most experts simply run like their orchestrator. An inherited effort the expert's model can't run is dropped; an explicit one is refused. Changing them on a live process (`POST /api/agents/:id/model`) applies before the next turn: a running turn finishes on its model. The values are saved, so a resumed process gets them as `query()` options. `activeModel` on the record is the model of the last main-loop call.
- **Notifications:** when an expert finishes a message sent with `notify`, the orchestrator gets a `[Manager notification]` message with a short preview. Notifications that pile up while the orchestrator is busy are combined into one message. If you interrupt such a turn, the orchestrator is told the expert "was interrupted by the user".
- **Rounds:** `propose_tracks` stores a plan and returns at once; the orchestrator waits for the user. Calling it again for the same round makes a new version. `track_id` ties an expert to its track. With the default round notifications, the replies of a round's tracks are held back and delivered together (with a `Round … : all … started tracks replied.` line) once every started track has replied and either every chosen track was started or the orchestrator is idle.
- **Questions:** `ask_user` stores a question set and returns at once. `question_id` on `message_expert` ties a routed question to the expert's reply, which becomes its answer.
- **Interrupt vs. stop:** interrupt cancels the current turn only; the reply is recorded as "Interrupted by the user." (not an error) and the next queued message follows. Stop also clears the queue and closes the process.
- **Archive:** hides an idle or stopped expert in the tree. Sending it a message unarchives it.
- **Files for handoffs:** the `orchestrate` skill tells the orchestrator to write prompt files and expect findings files in its own folder. Experts get access to the orchestrator's folder through `additionalDirectories`.
- **State:** `stateFile` holds the track plans and question sets, the agent tree, queues, session IDs, the last 20 final replies, the archive flag, the last activity time and the context use per agent. Transcripts are not copied: the UI reads them from Claude's own session files. After a restart, an agent that was mid-turn shows as `interrupted`. Its next message resumes the same session.
- **Cost** per turn is the difference in Claude Code's cumulative `total_cost_usd`. The first turn of a resumed process is priced from its own token use instead, because Claude Code restores the session's earlier cost counters on resume.
- **Context use** is the input size of the last model call of the last turn, divided by the main model's context window.
- **Pausing notifications:** a chat's **⋯** menu can pause its expert notifications, for a side conversation without experts' replies coming in between. While paused, the manager's messages to that chat stay in its queue (shown above the composer as *Expert notifications paused · N held*, with **Resume**) and the user's messages go first; an idle chat doesn't wake for them, and keep-warm ignores them. Resuming merges the held notifications into one message, which is delivered when the chat is free. The record's `notificationsPaused` holds the setting.
- **Keep-warm:** the prompt cache lasts 5 minutes (API keys, Foundry, extra usage) or 1 hour (subscriptions) after the last request that read it, and every read restarts that clock for free. With keep-warm on, the manager sends a ping shortly before the estimated expiry (1 minute before on a 5 minute cache, 5 minutes before on a 1 hour cache): a throw-away fork of the agent's session (`forkSession`, `persistSession: false`, the agent's own options, tools denied) that answers one line. Its request starts with exactly the prefix the agent's next turn sends, so it refreshes that cache entry, and the conversation never sees it. Choose it per agent in the cache tag's popover: for 15 / 30 / 45 minutes after each turn on a 5 minute cache, 2 / 4 / 8 hours on a 1 hour cache, and for chats also *while its experts work*. A ping reads the context at about 0.1× the input price; a cold cache is written again at 1.25× (5 minutes) or 2× (1 hour), so pinging stops 45 minutes (5 minute cache) or 8 hours (1 hour cache) after the last turn. A ping that reads less than half the expected context from the cache counts as a miss, and keep-warm stops until the next turn. Ping costs count towards the agent's cost. While keep-warm is on, new agent processes start with `idleCompaction: false`.

### API

`centurion api` (or `GET /api/docs` on a running server, `?format=json` for data) lists every endpoint with its body and result, and the server-sent events. Every call needs the token: `Authorization: Bearer <token>` or `?token=`. `/?token=<token>#agent=<id>` opens the UI on one agent.

Agent records carry `model` and `effort` (set, or `null`), `activeModel` and `activeEffort` (what the process last reported; effort is only known when Claude Code reports it), `archived` and `archivedWith` (the chat an expert was archived with), `lastActivityAt` (when a turn last ended or failed), `turnStartedAt` (while a turn runs) and `context: { usedTokens, windowTokens } | null`, besides the queue, replies, status and cost. Each reply has `durationMs` and `costUsd` for its turn.

Permission requests (`permission` events) carry `id`, `agentId`, `toolName`, `toolUseId`, `input`, the SDK's `title`, `description`, `reason` and `blockedPath` when given, `canAllowSession`, `defaultToNo`, `status` (`pending`, `allowed`, `allowedSession`, `denied`, `cancelled`) and the times. They live in memory only: a waiting request is cancelled when the turn is interrupted, stopped or ends, and after a restart the turn is interrupted as usual. `AskUserQuestion` is always denied with a pointer to `ask_user` (chats) or the reply (experts), and `ExitPlanMode` is always allowed.

## License

Apache License 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE). Centurion depends on the Claude Agent SDK, which has its own terms; you need your own Claude access to run it.
