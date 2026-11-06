# Agent manager

A local manager for Claude agents. You start **orchestrator** agents in a central project. They start **expert** agents in other folders through a small set of tools, and they get notified when the experts finish. A test page in the browser shows every agent, its live transcript with tool calls collapsed, and a box to message any agent directly.

This is the proof of concept. The real UI comes next.

## Run it (Windows or Linux)

```bash
npm install
cp agent-manager.config.example.json agent-manager.config.json   # then set a token
npm start
```

Open the URL it prints (it includes `?token=...`). Start an orchestrator from the sidebar with a name and an absolute folder path.

Auth comes from your normal Claude Code login (`claude` → `/login`), a `CLAUDE_CODE_OAUTH_TOKEN`, or provider variables such as Foundry. Put provider variables in the config's `env` or in your shell. If `ANTHROPIC_API_KEY` is set, it is used and billed instead of your subscription.

## Config (`agent-manager.config.json`)

| Field | Meaning |
|---|---|
| `host`, `port` | Where the API and page listen. Keep `127.0.0.1` unless you use plain `docker -p`. |
| `token` | Required on every API call (`Authorization: Bearer` or `?token=`). Empty disables the check, so don't do that with `bypassPermissions`. |
| `stateFile` | JSON state, relative to the config file. Keep one per environment: session IDs only exist on the machine that created them. |
| `permissionMode` | `auto` (classifier decides; what it can't decide is denied, not asked) or `bypassPermissions` (dev containers). |
| `model` | Model for every agent, or `null` for the Claude Code default. |
| `env` / `removeEnv` | Environment variables to add to or remove from agent processes. |
| `idleMinutes` | Close an agent's process after this many idle minutes (default 10, `0` = never). The next message resumes the session. |

Use `--config <path>` or `AGENT_MANAGER_CONFIG` to point at another config file. `AGENT_MANAGER_PORT`, `AGENT_MANAGER_HOST` and `AGENT_MANAGER_TOKEN` override the file.

## How it works

- **One agent = one Claude session** (Agent SDK `query()` with streaming input) in its own folder. Each agent has a **queue**, and the manager delivers one message per turn.
- **Orchestrator tools** (MCP server `manager`, orchestrators only):
  `create_expert(name, folder?, message?, notify?)`, `message_expert(expert_id, message, notify?)`, `get_expert_output(expert_id, last_n?)`, `list_experts()`, `stop_expert(expert_id)`.
  `folder` defaults to the orchestrator's own folder. `notify` defaults to true.
- **Notifications:** when an expert finishes a message sent with `notify`, the orchestrator gets a `[Manager notification]` message with a short preview. Notifications that pile up while the orchestrator is busy are combined into one message.
- **Files for handoffs:** the instructions in `prompts/orchestrator.md` tell it to write prompt files and expect findings files in its own folder. Experts get access to the orchestrator's folder through `additionalDirectories`. Edit the files in `prompts/` to change the instructions.
- **State:** `stateFile` holds the agent tree, queues, session IDs and the last 20 final replies per agent. Transcripts are not copied: the page reads them from Claude's own session files. After a restart, an agent that was mid-turn shows as `interrupted`. Its next message resumes the same session.

### API

| Method | Path | Body |
|---|---|---|
| GET | `/api/agents` | |
| POST | `/api/agents` | `{ name, cwd, message? }` creates an orchestrator |
| GET | `/api/agents/:id` | |
| GET | `/api/agents/:id/history` | Transcript from Claude's session file |
| POST | `/api/agents/:id/messages` | `{ text, notify? }` |
| POST | `/api/agents/:id/stop` | |
| GET | `/api/events` | Server-sent events: `snapshot`, `agent`, `delivered`, `message` |
