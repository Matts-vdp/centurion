# Next: archiving, split view, permission prompts

Three additions after the redesign (`docs/ui-design.md`). Each part ships on its own with its own commit, in the order below. Check each in the browser against a test manager, in light, dark and a narrow width.

Status: parts 1 (archiving) and 2 (split view) done.

## 1. Archiving chats and experts

Archiving says "this session is done, get it out of my sight". It stays findable, but out of the way.

Today only experts can be archived, only from the header's `⋯` menu, and they sit in an "Archived · n" row under their chat.

**Backend**
- `setArchived` accepts chats too. Archiving a chat archives its experts with it; unarchiving the chat brings back the experts that were archived with it (`archivedWith: <chatId>` on the expert record, cleared on unarchive), not ones archived on their own before.
- You can't archive a running agent or one with a queue. For a chat, that includes its experts.
- Archiving closes the agent's process (like `idleMinutes`); the next message resumes the session and unarchives it, as today.

**UI**
- An archive button on sidebar rows (on hover, and in a right-click menu), next to the header menu entry.
- One collapsed **Archived · n** group at the bottom of the sidebar for archived chats, with their experts under them. Archived experts of a live chat keep the per-chat row.
- The switcher still finds archived agents (dimmed, as today). Opening one reveals it in the tree.
- Archived agents don't count toward Needs you or the footer counts.

## 2. Split view

Any two agents side by side, not only orchestrator and expert.

**Model.** The main area holds one or two panes, each showing an agent (`AgentView` with its own header, transcript and composer). One pane is focused. The layout (`[left, right]` ids and the split ratio) is per browser in `localStorage`; the URL hash keeps the focused agent.

**Interaction**
- Drag a sidebar row (or a switcher result) onto the main area. A drop overlay shows the left and right halves; dropping on a half puts the agent there, replacing what was there. Dropping onto a single pane's centre replaces it.
- Menu fallback on sidebar rows: **Open in split**. Dragging is fiddly and doesn't work on touch.
- Clicking an agent in the sidebar opens it in the focused pane. Each pane has a close button; closing one leaves the other as a single pane.
- A draggable divider between the panes, with a minimum width per pane.
- Narrow widths (below about 900 px) show only the focused pane, with a small switch between the two.

**Details**
- Both visible panes count as seen for unread.
- Esc to interrupt and the keyboard shortcuts act on the focused pane only.
- The focused pane gets a subtle indicator (header text strength, not a coloured border).
- No backend change.

## 3. Permission prompts

When auto mode can't decide on a tool call, the agent asks the user instead of being denied. This replaces the "never asked" decision in `CLAUDE.md`.

**Decisions**
- A request **waits indefinitely**: no timeout. The agent stays mid-turn until you answer, interrupt or stop it.
- **Experts ask the user directly**, not through their orchestrator. It should be rare, so it doesn't need routing.
- **"Always allow" stays in the session**: the rule is added with destination `session`, never written to the repo's or user's settings. It is gone once the process closes (idle or restart), so the same ask can come back after a resume. That's accepted.

**Backend**
- `permissionPrompts: 'host'` with a `canUseTool` callback. Auto mode's classifier still decides first; the callback only runs for what it can't decide.
- The callback creates a pending request on the manager: id, agent, tool name, input, `title` / `description` / `decisionReason` / `blockedPath` from the SDK, the SDK's `suggestions`, `suppressAlwaysAllowRule`, and the time. It's sent as an SSE `permission` event and included in the snapshot, so a reload shows it. Not stored in the state file: after a restart the turn is interrupted as today and the request is gone.
- `POST /api/agents/:id/permission` with `{ requestId, decision: 'allow' | 'allowSession' | 'deny', message? }`. `allowSession` returns the suggestions with their destination set to `session`. `deny` passes the optional note to the agent as the deny message.
- The request is cleared when answered, when the SDK's `signal` aborts (interrupt or stop), or when the process exits.
- An agent with a pending request is not idle: the idle timer never closes it.
- `AskUserQuestion` and `ExitPlanMode` also reach `canUseTool` once prompts are on. Deny `AskUserQuestion` with a message pointing to `ask_user` (orchestrators) or to asking in the reply (experts), and allow `ExitPlanMode`, so neither shows up as a permission prompt.

**UI**
- A permission block in the transcript at the point of the call: the SDK's title (or the tool and a one-line summary), the input (command, path or diff, folded when long), and the reason. Buttons: **Allow**, **Allow for this session** (hidden when `suppressAlwaysAllowRule`), **Deny** with an optional note. When `defaultToNo` is set, focus starts on Deny and there's no one-key approve.
- The agent's state becomes **Needs you · permission**: it appears in the Needs you group, and the status line above the composer says `Waiting for permission: Bash · 3m`.
- Later, with configurable notifications: a desktop notification when the agent isn't on screen. There are no desktop notifications yet.
- An answered request folds into the work log as a short line (`Allowed Bash: npm test · for this session`).

**Docs**
- `CLAUDE.md`: change the permissions decision. `README.md`: the endpoint, the SSE event and the snapshot field. `docs/ui-design.md`: the permission block and the Needs you reason.
