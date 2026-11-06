# UI research: what chat and agent UIs do, and what our manager UI needs

This note feeds the design of the real UI (step 2). It covers what the best-known chat, IDE-agent and multi-agent UIs do, which of those patterns fit an orchestrator → expert tree, and what the backend still lacks for each v1 feature.

Starting point: [`public/index.html`](../public/index.html) already has a flat two-level tree with status dots, a transcript that collapses tool calls into `<details>`, a composer (Ctrl+Enter) and a Stop button. The API ([`src/server.ts`](../src/server.ts)) exposes the agent list and records, history from Claude's session files, messages, stop, and SSE events (`snapshot`, `agent`, `delivered`, `message`). Only complete messages are streamed: `forward()` drops everything except `assistant`, `user`, `result` and a few `system` subtypes.

## 1. Notable patterns

| Product | Pattern worth copying | Source |
|---|---|---|
| Claude desktop, Code tab | A sidebar of parallel sessions with grouping and sorting, and Ctrl+Tab to switch. Split view (Alt-click) or a new window (Ctrl-click). A **side chat** (`Ctrl+;`) asks a question about the session without adding to the main thread. Typing while it runs queues the message, and Esc interrupts. Three transcript levels (Normal / Thinking / Verbose, `Ctrl+O`). A tasks pane lists subagents and background commands, each stoppable. A context % card and a usage ring. Diff pane with line comments. OS notification when an unviewed session finishes. | [desktop docs](https://code.claude.com/docs/en/desktop) |
| VS Code Copilot (agent mode, sessions view) | Messages sent while it works can **steer** the running turn, **queue** until it ends, or **stop and send**; the Send button's default is configurable. Queued messages can be reordered by drag and removed. The sessions list shows status, file-change counts and per-chat unread markers. Grouping by workspace or time, pinning, archive / "done" filters, side-by-side grid. Subagent chats are read-only and stay linked to their parent. Checkpoints roll back files. | [chat overview](https://code.visualstudio.com/docs/chat/chat-overview), [manage sessions](https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions), [queueing write-up](https://bartwullems.blogspot.com/2026/03/you-no-longer-have-to-wait-for-copilot.html) |
| Cursor 3 Agents Window | One sidebar lists every agent, local or cloud, and the chats you use most can be pinned to the top. Runs agents across repos and environments (worktree, SSH, cloud). | [multi-agent help](https://cursor.com/help/ai-features/multi-agent.md), [background/cloud agents](https://cursor.com/help/ai-features/background-agents.md) |
| Zed agent panel | A collapsible summary above the composer counts the files and lines changed. **Review Changes** opens one multi-buffer tab with every hunk, each with keep / reject. A checkpoint is created on every edit. A threads sidebar. | [agent panel docs](https://zed.dev/docs/ai/agent-panel) |
| Windsurf Cascade | Enter while busy **queues** follow-ups. An in-chat **Todo list** shows the agent's plan, and you edit it by asking. | [Cascade docs](https://docs.windsurf.com/windsurf/cascade/cascade) |
| Cline | Plan / Act modes. Each tool call is approved or auto-approved per category. A header shows tokens, cache and the **context-window bar** with cost. Task history can be browsed and resumed. | [Cline tasks](https://docs.cline.bot/features/tasks/understanding-tasks), [CLI modes](https://docs.cline.bot/cline-cli/interactive-mode) |
| Roo Code (Orchestrator / Boomerang) | The closest match to our model: a parent task delegates subtasks, pauses, and gets each one's summary back. The UI shows the parent/child hierarchy and you can move between them. Its open issues (a lost "return to parent" button, orphaned children) show that **parent ↔ child navigation must be first-class and come from persisted links**. | [boomerang tasks](https://docs.roocode.com/features/boomerang-tasks), [issue #4881](https://github.com/RooCodeInc/Roo-Code/issues/4881) |
| Vibe Kanban | Agent tasks on a **board**: To do → In progress → In review → Done. Each card is a worktree with a branch, terminal, dev server and diff, and ends as a PR. | [repo](https://github.com/BloopAI/vibe-kanban) |
| Conductor / Crystal (now Nimbalyst) | Desktop apps with one workspace per agent, each with its own branch and terminal, a diff, checks and PR flow. Crystal added a session kanban. | [Conductor](https://www.conductor.build/workflows/run-parallel-claude-codes), [Crystal](https://github.com/stravu/crystal) |
| claude-squad | A TUI with a session list, a preview pane and a diff tab, on tmux and worktrees. Useful for its scope (list + preview + diff), but not the form factor, since the user dislikes TUIs. | [repo](https://github.com/smtg-ai/claude-squad) |
| opcode (Claudia) | A GUI over Claude Code sessions. A visual **timeline** of checkpoints with restore and fork. A **usage dashboard** by model, project and day. | [repo](https://github.com/winfunc/opcode) |
| ChatGPT / Codex web | A **task list** of parallel cloud tasks with stage-level progress and a done notification. Opening a task shows its diff. Reasoning is collapsed into "Thought for Ns". | [Codex walkthrough](https://hackernoon.com/chatgpt-codex-tutorial-ai-agent-in-the-cloud) |
| Open WebUI / LibreChat | Ctrl+K **fuzzy search** over titles, message bodies and tags, with `folder:` prefixes. Folders carry a system prompt. Chats can be marked read or unread. LibreChat: edit a message and regenerate as a sibling, or **fork** from any message into a new chat. | [Open WebUI organization](https://docs.openwebui.com/features/chat-conversations/chat-features/conversation-organization), [history search](https://docs.openwebui.com/features/chat-conversations/chat-features/history-search), [LibreChat fork](https://www.librechat.ai/docs/features/fork) |

**What most of them share:**
1. A sidebar list with status and unread state.
2. Collapsed tool calls, with an optional verbose mode.
3. Typing while the agent runs queues or steers instead of blocking.
4. Esc interrupts.
5. A context or cost indicator.
6. A diff or review surface.
7. A notification when something you aren't watching finishes.

Only Roo and VS Code (subagent chats) model a **hierarchy**, and neither does it well. That is our differentiator.

## 2. Mapping to our needs

- **Tree of orchestrators → experts.** The sidebar is a real tree with collapsible orchestrators. Each orchestrator row rolls up its children ("2 running · 1 failed") so a collapsed tree still shows trouble. Several orchestrators are just several roots.
- **Fast switching.** Ctrl+K quick switcher, `Alt+↑/↓` to the previous or next agent in the tree, `Alt+←` to the parent, and a back/forward history like VS Code's `Alt+←/→`. Optional tabs or split panes for agents you keep open.
- **Question an expert, then go back.** Clicking an expert opens its transcript with a **breadcrumb** (`Orchestrator ▸ expert`). A persistent "↩ back to orchestrator" button and `Alt+←` return to the parent. In the orchestrator's transcript, each `create_expert` / `message_expert` tool card links to the expert. Messages you type to an expert are labelled "from you" so the orchestrator's view of the expert stays distinguishable. A "side question" (like the desktop's side chat) is a *later* option, since it needs a forked session.
- **Clear status.** One status vocabulary everywhere: running / idle / queued (n) / failed / stopped / interrupted, plus a derived **waiting on experts** for orchestrators. A top status strip shows global counts that can be clicked as filters.
- **Later.** File views (a read-only file tree and diff per agent `cwd`) and a dev-system panel (running / blocked / queued tasks) get their own sidebar views, like VS Code's activity bar. That layout leaves room for them from v1.

## 3. Prioritized features

### v1 UI
| Feature | Why |
|---|---|
| Collapsible agent tree with status dots, queue count and child roll-up | The core mental model; trouble must be visible with the tree collapsed. |
| Global status strip (running / queued / failed / needs attention) that filters on click | One look answers "what is going on?" across all orchestrators. |
| Unread / "finished while you were away" badge per agent | The most common pattern for many parallel sessions; tells you where to look next. |
| Quick switcher (Ctrl+K) plus keyboard tree navigation, `Alt+←` to the parent and back/forward history | Fast switching was the explicit ask; mouse-only trees are slow with 10+ agents. |
| Breadcrumb plus "back to orchestrator", and expert links in `create_expert` / `message_expert` cards | Makes "question an expert, then return" a single click either way. |
| Transcript with markdown and code highlighting, collapsed tool cards (name + one-line summary + status), errors highlighted | What every surveyed UI does; transcripts are mostly tool noise. |
| Verbosity toggle (normal / verbose), with thinking collapsed as "Thought for Ns" | Lets you dig into one turn without cluttering the default view. |
| Message source labels (you / orchestrator / manager notification), including in history | Ties the transcript back to the tree; today history loses the source. |
| Live streaming of assistant text and a "running tool X for Ns" indicator | Without it, a long turn looks frozen. |
| Composer that queues while running, a visible queue with remove, and Esc to interrupt | Matches Claude desktop, VS Code and Windsurf; the backend already queues. |
| Per-agent cost plus context % from the last turn | Lets you see an orchestrator nearing its context limit before it degrades. |
| Desktop notification on finish or failure for agents you aren't viewing | Lets you work elsewhere while experts run. |
| Start an orchestrator dialog (name, folder picker or recent folders) | The test page's free-text form is error-prone on Windows paths. |

### Soon
| Feature | Why |
|---|---|
| Split view or tabs for two agents (for example orchestrator \| expert) | Watch an expert while the orchestrator reacts to it. |
| Queue editing: reorder, edit, "send now / steer" | VS Code-style steering; useful once queues get long. |
| Start an expert from the UI under an orchestrator, plus rename and archive | The tree fills up; today only the orchestrator can create experts. |
| Tasks / plan card from `TodoWrite` output pinned above the transcript | Cascade, VS Code and Claude desktop all show the agent's plan. |
| Full-text search across agents' transcripts (Ctrl+Shift+F) | "Which expert said X?" comes up quickly with many experts. |
| Changes summary per agent (files and lines, from `git diff` in its `cwd`) | Zed's or Claude desktop's changes card; a cheap step toward file views. |
| Subagent (Task tool) runs shown nested under the tool card | Their internals are hidden today (`parent_tool_use_id` is skipped). |
| Approval prompts surfaced in the UI (when `permissionMode` allows asking) | Today, actions the classifier can't decide are denied; an ask flow would cut wasted turns. |

### Later
| Feature | Why |
|---|---|
| File tree, file viewer and diff viewer per agent | Asked for; needs file and git endpoints. |
| Dev-system panel: running / blocked / queued tasks, linked to agents | Asked for; depends on that system's API. |
| Board view of agents and tasks by status (Vibe Kanban style) | An alternative view once the dev-system link exists. |
| Side question / fork an expert session without touching its main thread | The desktop side chat and LibreChat fork; needs session forking. |
| Usage dashboard (cost per orchestrator, per day) | opcode-style; nice once the system runs daily. |
| Checkpoints and rewind | Valuable, but complex and only useful with file views. |

## 4. Backend and API gaps for v1

| v1 feature | Gap |
|---|---|
| Live streaming | Set `includePartialMessages: true` in `buildOptions` and forward `stream_event` deltas (text and `input_json_delta`). Throttle or coalesce them, about every 50–100 ms, and only send them to clients that need them (an SSE `?agent=` filter, or a `delta` event the client ignores). [SDK streaming docs](https://code.claude.com/docs/en/agent-sdk/streaming-output) |
| Esc to interrupt | Add `POST /api/agents/:id/interrupt`, which calls `q.interrupt()` only and **keeps the queue and the process**. Today `stop()` clears the queue and closes the process. |
| Visible queue with remove | Add `DELETE /api/agents/:id/queue/:msgId`. The queue is already in the record and changes arrive through `agent` events. |
| Unread badges | Persist `lastActivityAt` per agent (last `result` or error). The client keeps `lastSeenAt` in localStorage for v1; it moves server-side (`POST /seen`) if several browsers are used. |
| "Needs attention" / failed | Already derivable from `status` plus `lastError`. Add a reason when an expert fails and its parent was notified. |
| Waiting on experts | Derive on the client from children with `running` or a non-empty queue; no backend change. |
| Source labels in history | History comes from Claude's session file and doesn't know who sent a prompt. Persist a small map from delivered prompt to `source` (per agent, keyed by text hash or delivery time), or return `deliveries[]` with `/history`. |
| Expert links in tool cards | `create_expert` already returns the expert's record (id) in its tool result, so the client can parse it. `message_expert` takes `expert_id`. Nothing needed beyond a stable JSON shape. |
| Context % | Store the last turn's `usage` (input + cache tokens) and the context window (`modelUsage[*].contextWindow` from `result`) on the record. |
| Missed events after reconnect | SSE has no event ids. On reconnect the client re-fetches `/history` for the open agent (the snapshot covers records). Fine for v1. |
| Long transcripts | `/history` returns everything. Add `?limit=` / `?before=` once transcripts get slow; not urgent. |
| Folder picker | Add `GET /api/recent-folders` (from existing agents' `cwd`) and optionally `GET /api/fs/list?path=` for browsing. Only the first is needed for v1. |

## 5. Layout suggestions

**A. VS Code-style (recommended).** An activity bar for future views, a tree sidebar, the transcript with a breadcrumb, and an optional right panel.
```
┌──┬────────────────────┬───────────────────────────────────────┬──────────────┐
│≡ │ ● 3 run ◌ 2 q ✖ 1  │ Orch-A ▸ expert-api        ↩ back  ⎋  │ Details      │
│A │▾ Orch-A   waiting  │───────────────────────────────────────│ status  run  │
│F │   ● expert-api  •  │ from orchestrator: "Check the auth…"  │ cost  $0.42  │
│T │   ✓ expert-db      │ ▸ Read src/auth.ts                    │ ctx   41%    │
│  │   ✖ expert-ui   !  │ ▸ Grep "token" (12)                   │ queue (2)    │
│  │▸ Orch-B   idle     │ The token is checked in…  ▍streaming  │  · "also…" ✕ │
│  │                    │───────────────────────────────────────│ todo         │
│  │ [+ Orchestrator]   │ [ message… (Enter queues, Esc stops) ]│  ☑ ☐ ☐       │
└──┴────────────────────┴───────────────────────────────────────┴──────────────┘
 A=Agents  F=Files (later)  T=Tasks / dev system (later)
```

**B. Orchestrator + expert split.** The same sidebar, but opening an expert from an orchestrator opens it to the right, so you can question the expert and keep the orchestrator in view. Closing the right pane is "back".
```
┌────────────────┬──────────────────────────┬──────────────────────────┐
│ tree           │ Orch-A                   │ expert-api      ✕ close  │
│                │ ▸ create_expert → api ↗  │ ▸ Read …                 │
│                │ [Manager] api finished   │ answer…                  │
│                │ [ message orch… ]        │ [ ask expert… ]          │
└────────────────┴──────────────────────────┴──────────────────────────┘
```

**C. Overview board (a "later" home screen).** Columns by status across all orchestrators. Click a card to open layout A for that agent. It becomes the natural place to merge in dev-system tasks.
```
 Running        Queued          Needs attention     Idle / done
┌───────────┐  ┌───────────┐   ┌───────────────┐   ┌───────────┐
│expert-api │  │expert-db 2│   │expert-ui ✖    │   │Orch-B     │
│Orch-A·3m  │  │Orch-A     │   │"tests failed" │   │$1.10      │
└───────────┘  └───────────┘   └───────────────┘   └───────────┘
```
