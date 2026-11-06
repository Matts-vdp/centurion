# Next: experts from the UI, subagents, fork and rewind

Four additions after archiving, split view and permission prompts (`docs/next-plan.md`). Each part ships on its own with its own commit, in the order below. Check each in the browser against a test manager, in light, dark and a narrow width.

Status: planned.

## 1. Start an expert from the UI

The user can start an expert under a chat without asking the orchestrator.

- **Where:** a **New expert** entry in a chat row's right-click menu and in the chat's header `⋯` menu. A small form opens in the sidebar under that chat, like **New chat**.
- **Fields:** name, folder and an optional first message. The folder is a list of recent folders (every folder an expert has used, newest first, plus the managing folder), and you can type another absolute path. Model and effort follow the usual rule: the orchestrator's current ones.
- **The orchestrator is not told.** The expert shows up in its `list_experts`, and the user tells the orchestrator to read its output when they want that. The first message is from the user, so its reply doesn't notify the orchestrator either.
- **Backend:** `POST /api/agents/:id/experts` with `{ name, cwd?, message? }`, using `Manager.createExpert` with the message sent as `user` and `notify: false`. The recent folders are computed in the UI from the agent records; no endpoint.

## 2. Subagents

A subagent (the `Agent` / `Task` tool) is part of its agent's turn, but it is an agent: it gets its own line in the transcript instead of hiding as one step of a work log.

- **Collapsed (the usual case):** one line with a small sunken mark holding the bot glyph, `Subagent`, its description, and on the right its state: while running, the latest progress summary (`Reading the auth module`) and a live timer; when done, `Done in 1m 12s · 14 tools`; failed in coral. It breaks the work log like a delegation does, so it is visible without opening anything. It has no surface of its own: a subagent is part of the turn, not another agent you can open.
- **Expanded:** the prompt (folded after a few lines), its steps as a work log, and its final reply as prose. Steps come from the live stream while it runs (messages with `parent_tool_use_id`), and from its own transcript file afterwards.
- **Backend:** `agentProgressSummaries: true` on every agent, so `task_progress` events carry a one-line summary; the server forwards `task_started`, `task_progress` and `task_notification`. `GET /api/agents/:id/subagents/:toolUseId` returns the subagent's messages (`listSubagents` + `getSubagentMessages`, matched by `parent_tool_use_id`).
- Background subagents show `Running in the background` until their notification arrives. Nested subagents show as steps of their parent subagent.

## 3. Fork

Fork copies a conversation into a new agent from a chosen turn. It also covers side questions: fork, ask, archive the fork.

- **Where:** hovering a message into the agent shows a small toolbar on its speaker line: **Fork from here** and **Rewind** (part 4). Fork keeps that turn and everything before it.
- **What you get:** a new agent named `<name> (fork)`, the same kind, folder, parent, model and effort, idle, opened in the focused pane. A forked chat is a new chat; a forked expert sits under the same orchestrator. The original is not changed and can keep running.
- **Backend:** `POST /api/agents/:id/fork` with `{ promptUuid }`. The manager finds the end of that turn in the session (the entry before the next prompt) and calls `forkSession(sessionId, { upToMessageId })`. The fork's record gets the new session id and the replies of the kept turns, so footers still show. Not allowed for a turn that is still running.
- Prompt uuids: history messages have them, and the manager now sets a `uuid` on every message it delivers, so live prompts have one too (`QueuedMessage.uuid`, sent with `delivered`).
- **Plans and question sets** stay with the original chat. In a fork they show as one quiet line (`Track plan from <chat> · Round 1 · title`) without Start or Send. The original's experts are not the fork's: its delegations still show their live state, but the fork can't message them.

## 4. Rewind

Rewind drops a turn and everything after it, in the same agent. Files are not touched.

- **Where:** **Rewind** on the same hover toolbar. A confirm step in place (`Drop this turn and the 3 after it? Files are not changed.`). The rewound message goes back into the composer, so you can edit and resend it.
- **Only when idle:** not while running, with a queue, or with a pending permission request.
- **How:** the same fork, cut at the entry just before that prompt, and the agent's record switches to the new session (rewinding the first turn starts a fresh one). The process closes; the next message resumes the new session. The old session stays on disk. Replies of the dropped turns are removed and the context number is cleared until the next turn.
- **Side effects stay.** Experts started in the dropped turns keep running and stay in the tree; stop or archive them yourself. Waiting plans and open question sets from the dropped turns are removed (they'd otherwise keep the chat in Needs you); started plans stay with their tracker.
- **Backend:** `POST /api/agents/:id/rewind` with `{ promptUuid }`.

## Docs

`README.md`: the endpoints and SSE events. `CLAUDE.md`: the fork and rewind decisions. `docs/ui-design.md`: the subagent line, the message toolbar, the New expert form.
