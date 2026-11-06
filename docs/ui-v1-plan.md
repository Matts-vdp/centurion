# UI v1 plan

Replace the bare test page (`public/index.html`) with a real VS Code-style UI for the agent manager. Background: `CLAUDE.md` describes the setup; `docs/ui-research.md` has the research. This plan is the agreed scope. Items marked *soon* in the research stay out.

## Scope

**In v1**

1. **Layout (VS Code-style).**
   - An activity bar on the left, with only the Agents view for now; files and the user's dev system get views there later.
   - A sidebar holding the agent tree.
   - The main area: breadcrumb, agent header, transcript and message box.
   - A dark and a light theme, following the system setting.
2. **Agent tree.**
   - Orchestrators as roots, with their experts beneath.
   - Each row shows a status dot (running / idle / error / stopped / interrupted) and a queue count.
   - An orchestrator row rolls up its children ("2 running · 1 error"), so problems show while it is collapsed. Orchestrators can be collapsed.
   - **Unread badge:** the agent finished a turn or failed since you last opened it.
   - **Archived experts** go into a collapsed "Archived (n)" group under their orchestrator. Archiving is an action on an idle or stopped agent; unarchiving is also possible.
   - "New orchestrator" asks only for a name and an optional first message.
3. **Breadcrumb and navigation.** `orchestrator ▸ expert`, with a "Back to orchestrator" button when an expert is open. Clicking a tree row switches agents.
4. **Transcript.**
   - Assistant text is rendered as markdown with code highlighting.
   - **Who sent each message** is shown for both live and history messages, and is derived from the text with no backend change:
     - `[Message from orchestrator "…"]` means from the orchestrator
     - `[Manager notification]` means a manager notification
     - anything else means from you
     - Strip the prefix when displaying.
   - **Tool cards** are collapsed by default and show the tool name, a one-line summary and a status: pending with elapsed time, done, or error. Expanding a card shows the input and the result.
     - Useful summaries: Bash shows the command; Read, Write and Edit show the path, and Edit shows old → new.
     - For manager tools, drop the `mcp__manager__` prefix.
     - `create_expert` and `message_expert` cards link to the expert: the id comes from the tool result JSON or from `expert_id` in the input.
   - Errors, failed results and `permission_denied` events are clearly highlighted.
   - A "Running Bash for 12s…" indicator shows while the agent is running and the last tool call has no result yet. A "Thinking…" indicator shows when it is running and no tool is pending.
   - Thinking blocks and subagent internals (`parent_tool_use_id`) stay hidden.
5. **Message box.**
   - Enter sends; Shift+Enter adds a new line.
   - Sending while the agent is running queues the message. The queue is shown above the box, and each entry has a remove button.
   - **Esc**, or a Stop button, interrupts the current turn **without** clearing the queue.
   - The existing "Stop agent" action, which clears the queue and closes the process, stays available in the header's menu.
6. **Agent header:** name, kind, folder, status, cost, and **context %** (last turn's input tokens divided by the context window).

**Out of v1:** token streaming, the Ctrl+K switcher and keyboard tree navigation, the status strip, the verbosity toggle, split view, desktop notifications, file views, and creating experts from the UI.

## Backend changes

| Change | Details |
|---|---|
| `orchestratorFolder` config | The folder every orchestrator runs in. Default: the folder the manager was started from. `POST /api/agents` takes `{ name, message? }`. Remove `cwd` from the API, but keep validating the configured folder at startup. |
| Interrupt | `POST /api/agents/:id/interrupt` calls `q.interrupt()` and keeps the queue and the process. The turn ends normally through its `result`; record the reply as "Interrupted by the user." and **don't** count it as an error status. Notify the parent if the message had `notify` ("was interrupted by the user"). Then deliver the next queued message. |
| Remove a queued message | `DELETE /api/agents/:id/queue/:messageId`. |
| Archive | `archived: boolean` on `AgentRecord`. `POST /api/agents/:id/archive` with `{ archived }`; refused while the agent is running. `list_experts` still shows archived experts, with the flag. |
| Last activity | `lastActivityAt` on `AgentRecord`, set when a turn ends or fails. The client stores `lastSeenAt` per agent in `localStorage` (inside try/catch) and shows unread when `lastActivityAt > lastSeenAt`. |
| Context usage | After each `result`, store `context: { usedTokens, windowTokens }`. `usedTokens` = `usage.input_tokens + cache_read_input_tokens + cache_creation_input_tokens` of that turn; `windowTokens` = `contextWindow` from `modelUsage` (the main model's entry). |
| Migration | Records loaded from older state files get the defaults `archived: false`, `lastActivityAt: updatedAt`, `context: null`. |

Keep the existing endpoints and SSE events working. Update the README's config and API tables and `CLAUDE.md`.

## Frontend setup

- `ui/`: **Vite + React + TypeScript**, kept small. For markdown, `react-markdown` + `remark-gfm`, and a light highlighter (`rehype-highlight` or similar). No UI framework is needed; use plain CSS with variables for the themes.
- Dev: run the Vite dev server with `/api` proxied to the manager. Production: `npm run build` builds into `dist/ui`, and the manager serves it at `/` (fall back to a short "run npm run build" page if it is missing). Delete `public/index.html` once the new UI works.
- Scripts: `npm run dev` runs manager and UI together, `npm run build` builds the UI, and `npm start` serves the built UI. Typecheck covers `ui/` too.
- Token: read it from `?token=` once, keep it in `sessionStorage` (try/catch), and send it as `Authorization: Bearer` and `?token=` for SSE.
- Data flow: the SSE `snapshot` and `agent` events feed an agent store. Opening an agent loads `/history`, then appends live `message` and `delivered` events for that agent, with duplicates removed by `uuid`. Re-fetch the open agent's history when the SSE connection reconnects.

## Done when

- `npm run typecheck` and `npm run build` pass.
- A real end-to-end run (tiny prompts; follow the testing notes in `CLAUDE.md`: a separate config, port and state file, and the Claude desktop app's env vars removed) shows:
  - the tree with roll-up and unread badges
  - tool cards collapsed, with working expert links
  - who sent each message, in live and history views
  - a message queued while running, then removed
  - Esc interrupting a turn while the queue survives
  - archiving an expert
  - context % filled in
- Checked visually in the browser pane, in both themes and at a narrow width.
- Committed in logical parts with short messages.
