# Send now (steering)

Enter keeps queuing while an agent runs. Each queued message gets a **Send now** button that hands it to the running turn, the way Claude Code takes what you type mid-turn. This plan covers what the SDK does, how `AgentRuntime` and `Manager` track it, and the UI.

## What the SDK does (observed)

These were tested with `@anthropic-ai/claude-agent-sdk` 0.3.318, streaming input, `claude-haiku-5-5`, host env stripped. Scripts and raw logs are in `handoffs/steer/scratch/` (`steer.mjs <scenario>`, `<scenario>.log`). The first message asks for `sleep 8` in Bash and then the word DONE. The second message is "Also add the word BANANA", sent 1.5 s after the `tool_use` (unless noted).

| Case | What happened | Results |
| --- | --- | --- |
| `next` during a tool | Bash ran to the end. The message was folded in after the `tool_result`, and the model answered both ("DONE BANANA") in the same turn. | **1**. `result.user_message_uuids = [first, steered]` |
| no `priority` during a tool | Same as `next`. Pushing mid-turn always folds in at the next tool boundary. | 1 |
| `later` during a tool | Waited for the turn to end ("DONE"), then ran as its own turn ("DONE BANANA"). This is our queue. | 2 |
| `now` during a tool | **The running tool was not interrupted**: Bash finished its 8 s. Then the turn was aborted before the next model call. Its `result` was `success` with `result: ""` and only the first uuid. A new turn ran the steered message. | **2** |
| `now` while generating text | The stream was cut at once. The partial text ("The last keeper of G") stays in history as the assistant's message, the `result` is `success` with the partial text, and the new turn answers the steer. No `[Request interrupted…]` marker. | 2 |
| `next` while generating text (no tool follows) | The text finished, then the steer ran as its own turn. | 2 |
| `now` during the final text (after a tool) | Same as `now` while generating: the final text was cut after "The", and a new turn followed. | 2 |
| `now` while idle (after `result`) | Started a normal turn at once. Priority makes no difference when idle. | 1 per send |
| two `now` 0.5 s apart | **Merged into one user message**: the texts were joined with `\n`, stored under the **last** uuid only. The first uuid is not in history. Both uuids are in `user_message_uuids`. | 2 |
| `now` with an image | Works the same way. The content blocks (image + text) are stored in history. | 2 |
| `now` / `next` with `canUseTool` | `sleep` was auto-allowed, so the permission callback was never reached. **Untested; see the test plan.** | — |

Other findings:

- **History.** Every steered message shows up in `getSessionMessages()` as its own `user` message with the `uuid` we set, after the `tool_result` it followed or the partial text it cut. A merged pair is the exception (see above). The SDK does **not** echo a steered prompt on the stream as a `user` message.
- **Binding.** `result.user_message_uuid(s)` are typed (sdk.d.ts ≈6034) and list every prompt the turn consumed: the batch that started it, then any folded in. The first top-level assistant message of a turn carries them too, but a folded `next` gets no new stamp until the result.
- **`command_lifecycle` messages** (`{ command_uuid, state: queued | started | cancelled | completed }`) arrive on the stream for every uuid-stamped prompt. `started` comes at the exact moment of folding, and `cancelled` marks the turn a `now` aborted. They are **not in sdk.d.ts**: they pass through from the CLI untyped. Use them only as a hint, never as the source of truth.
- **Cost.** `total_cost_usd` stays cumulative per `query()`, so per-result differences still add up correctly. A turn aborted by `now` can report `usage` all zeros (textNow: `usage` 0/0/0/0, but the cost delta was $0.00013), because the cut call isn't in `result.usage`. `ownCost` would price such a turn at 0. That is negligible.
- **Batching.** The SDK merges "several messages sent close together" into one turn. Centurion's one-at-a-time delivery avoids this today. A steer is the only push made while a turn is running.
- **Interrupts.** `interrupt()` leaves pending async messages queued (`still_queued` in its response), and they run after the interrupt's result. `cancel_queued: true` exists on the control request, but `Query.interrupt()` doesn't expose it. Stopping (closing the process) drops them.
- `WebFetch` / `WebSearch` calls "step aside" for a user message (`tool_use_result: { detachedToolCall: true }`, sdk.d.ts ≈6664), and their result reaches a later turn. We don't render that today. See *Later*.

## Design

### Which priority: `next`

**Send now sends with `priority: 'next'`.** It never throws away work in progress. It joins the turn at the next tool boundary, which is what Claude Code does with text typed mid-turn. If the turn ends without another tool call, it simply becomes the next turn, ahead of the rest of the queue. `now` aborts the model call that is streaming and leaves a cut-off assistant message in history. Within a turn, a tool is the only thing it can't cut short, so the only gain is skipping the rest of the current reply. That is close to Esc followed by Send. *Interrupt and send* (`now`) is an open question; it is not part of v1.

### The amended rule

> **One message starts a turn.** The next queued message is sent only after the previous `result`. The one exception is **Send now**: a steered message is handed to the running process at once (`priority: 'next'`). It either joins the running turn (it appears in that turn's `result.user_message_uuids`) or becomes the next turn. Each `result` settles exactly the entries it lists. Only one steer is in flight at a time.

The "one in flight" rule exists because two pushes merge into one prompt under the last uuid. That would lose a cut point, and it would join two senders' prefixes (`ui/src/timeline.ts`) into one prompt. A second Send now waits until the first has been taken in. The button shows as disabled ("Sending…") and the entry stays in the queue.

### Runtime (`src/agent.ts`)

- New record field `rec.steered: QueuedMessage | null`: delivered to the SDK, not yet settled. It is persisted like `current`.
- `steer(messageId)`:
  - If the agent is not busy, move the entry to the front and `pump()`. This is the same as a normal send.
  - Refuse when it is busy with a steer already pending, when the entry is held, or while `interrupting` or `stopping`.
  - Otherwise take the entry out of the queue and give it a `uuid`. Build `content` (the same hook as delivery), call `onDeliver(rec, entry, content, { steered: true })`, and push it with `priority: 'next'`. The push does **not** call `applySettings`: a model change still waits for the next real turn.
- **Settling on `result`** (`finishTurn`). Let `ids = result.user_message_uuids ?? [result.user_message_uuid]`.
  - If the steer is pending and its uuid is in `ids`, it joined. The reply covers both entries: record `reply.uuids = [current.uuid, steered.uuid]`, call `onTurnEnd(rec, [current, steered], reply)`, and clear `steered`.
  - If the steer is pending and its uuid is **not** in `ids`, the SDK still holds it as the next turn. End the current turn as usual, then **carry over**: `current = steered`, `steered = null`, `busy` stays true, and `turnStartedAt`, `requestAt` and `lastCallInput` are reset. Nothing is pushed. `pump()` must see `busy` and do nothing.
  - Fallback when neither uuid field is present (an older CLI): treat the steer as joined if a `command_lifecycle started` for it was seen before the result, otherwise carry it over. When `ids` is missing, the lifecycle hint is the only signal.
- `command_lifecycle started` for the steered uuid (when seen) marks it taken in, so the UI can turn "Sending…" into "joined". `cancelled` is ignored: we never send `now`.
- **Interrupt** with a steer pending: the current turn is recorded as interrupted, and the steer carries over and runs. This matches "interrupt keeps the queue". **Stop**: `endTurn` for `current`, and the steer is dropped along with the queue (its images are already gone; it was delivered).
- **Process exit or crash mid-turn**: `failTurn` covers `current`. A pending steer is put back at the **front of the queue** with its text (its images are gone; the `delivered` event already showed them), because it may never have reached the session. It is better to resend than to lose it.
- `onTurnEnd` changes from one `handled` to `handled: QueuedMessage[]`. `endTurn` still pushes **one** `Reply` per `result`, so `replies` stays one per turn and cost, duration and context stay per result.

### Manager (`src/manager.ts`, `src/types.ts`, `src/state.ts`)

- `steer(id, messageId)` checks the agent and the entry and calls `rt.steer`. A new route `POST /api/agents/:id/queue/:messageId/send-now` returns the agent. A second route field lets the composer skip the queue: `POST .../messages` with `{ now: true }` queues the message and steers it in one call (and falls back to a normal queue when a steer is already pending).
- **Which entries can be sent now:** `source: 'user'` (typed in the UI) and orchestrator messages to an expert (`source: 'orchestrator'`, see the open question). Never `manager` notifications: they are combined, held while paused, and drive the round check. Folding them into a running turn would change the orchestrator's workflow behind its back. Never entries with `question` (a routed question's answer is "the reply of its turn", which a join would blur).
- `onDeliver` gets `{ steered }` and passes it on in the `delivered` event (`{ agentId, message, images?, steered? }`). Images are deleted at that point as before.
- `onTurnEnd(rec, handled[], reply)`. Permissions are cancelled only once per result. The warm reset happens once. For each handled entry, apply its `track` and `question` and work out the notification. If **any** entry has `notify`, send **one** notification (the `onTurnEnd` notification text covers the turn, not the message).
- `recover()`: a persisted `steered` is treated like the turn's `current` (interrupted). Its text is pushed back to the front of the queue, as on a crash.
- `STATE_VERSION` 2 with a migration that adds `steered: null`.
- **Keep-warm** needs no change: steering only happens while busy, and a carry-over keeps `busy` true. **Notifications paused**: held entries can't be steered, and `isHeld` doesn't change.

### History, fork and rewind

- A joined prompt is its own `user` message in history, with our uuid, after a `tool_result` (or after the text of a turn that ended). `ui/src/timeline.ts` already turns it into a prompt item, and the sender prefixes still work because each steer is a single sender's text (one in flight).
- `ui/src/blocks.ts` `assignReplies`: with timestamps, the one reply goes to the last prompt before it, which is the steered one. The prompt it joined gets **no footer**: render it as continuing (its work log flows into the steered prompt's turn) with a quiet line `Continued with your next message` (`--text-3`). The UI tells joined from carried-over by `reply.uuids` (a joined pair names two uuids). With no `uuids` (older replies) nothing changes.
- **Rewind** to a steered prompt cuts just before it. The session then ends on a `tool_result`, and the next message continues from there. That is a valid conversation (Claude Code appends the user message). Rewind is disabled while running, so there is no race.
- **Fork** at a prompt whose turn was joined: "end of the turn" would be just before the steered prompt, mid-turn after a `tool_result`. Fork at the **joined pair's end** instead, i.e. treat the two prompts as one turn for the fork button (the fork menu acts on the steered prompt's turn). This keeps forks at real turn ends.

### UI

- **Queue row** (`Composer.tsx`, `QueueList`): on hover (always on touch), a **Send now** icon button (`corner-down-right` or `arrow-up`, in `--text-2`, aqua on hover as an action) sits before the remove button, labelled `Send now: joins this turn at its next step`. It shows only while the agent is running and the entry can be steered. While a steer is pending, the steered row stays at the top of the list with `Sending…` in `--text-3` and no buttons, and the other rows' Send now buttons are disabled with the tooltip `One message at a time`. When `delivered` (steered) arrives, the row leaves the queue.
- **Transcript.** A live `delivered` event with `steered` appends the prompt where the stream currently is. `store.ts` must **not** clear the activity's running tool for a steered delivery: today `delivered` does `setActivity(tool: null)`. History puts it after the `tool_result`, so after a refetch the order can differ by one tool result. That is acceptable. If it bothers us, place it on `command_lifecycle started` instead. The steered prompt's speaker line gets `sent during the turn` as meta in `--text-3`.
- **Keyboard.** **Ctrl+Enter** (⌘+Enter on macOS) in the composer while running sends the typed text now (`{ now: true }`). The footer hint while running reads `Enter queues · Ctrl+Enter sends now`. When idle, Ctrl+Enter is the same as Enter. In the queue list there is no extra focus path for v1; it is a hover button reachable with Tab, as remove is.
- **`docs/ui-design.md`**: replace "Later: drag to reorder and "send now"" in the composer section with the Send now row button, the `Sending…` state, the Ctrl+Enter hint and the `sent during the turn` meta. Add a line to the transcript section on continued turns.

## Changes per file

- `src/types.ts`: `AgentRecord.steered`, `Reply.uuids?`, and `canSteer(rec, m)` (also used by the UI through the shared types, mirrored in `ui/src/status.ts`).
- `src/agent.ts`: `steer()`, the settling and carry-over in `finishTurn`, the `onDeliver` options, `onTurnEnd` taking an array, the `command_lifecycle` hint, and the interrupt, stop and exit handling of `steered`. Update the class comment to the amended rule.
- `src/manager.ts`: `steer()`, `onTurnEnd` over several entries, the `delivered` `steered` flag, `recover()`, and `sendMessage(..., { now })`.
- `src/state.ts`: version 2 and its migration.
- `src/server.ts`: the `send-now` route and `now` on `messages` (route docs, `SSE_EVENTS` `delivered` text). `npm run check:docs`.
- `ui/src/api.ts`: `commands.sendNow`, and `now` on send.
- `ui/src/store.ts`: keep the activity on steered `delivered`.
- `ui/src/timeline.ts`: carry `steered` onto the live prompt item.
- `ui/src/blocks.ts`: joined turns (no footer, the continued line) via `reply.uuids`.
- `ui/src/Composer.tsx`: the row button, `Sending…`, Ctrl+Enter, the hint.
- `ui/src/Transcript.tsx`: the meta, and fork on a joined pair.
- `ui/src/styles.css`: only if the button needs a style (reuse `.icon-button`).
- `docs/ui-design.md`, `CLAUDE.md` (the "One message per turn" decision text, and `delivered` in the layout list).

## Steps

1. Runtime and manager: `steered`, `steer()`, settling and carry-over, the array `onTurnEnd`, the state migration, and the routes. Commit.
2. Test against the SDK with a scratch config (see the test plan, steps 1 to 6). Commit fixes.
3. UI: the queue row button and `Sending…`, Ctrl+Enter, the steered `delivered` in the store and timeline. Commit.
4. Transcript: joined turns, the meta and fork on a joined pair. `docs/ui-design.md` and CLAUDE.md. Commit.
5. Browser check: light and dark, narrow, touch (always-visible buttons).

## Test plan

Use a separate config, port and state file with tiny prompts, as in CLAUDE.md.

1. **Join.** Ask for `sleep 8` then DONE, queue "say BANANA", Send now during the sleep. Expect one reply "DONE BANANA" with `uuids` of both, the queue empty, `status` idle after, cost added once, and two prompts in the transcript with one footer.
2. **Carry-over.** Ask for a 200-word story (no tools) and Send now while it writes. Expect two replies, two footers, and `turnStartedAt` reset for the second.
3. **One in flight.** Queue two messages and Send now on both quickly. Expect the second disabled until the first is delivered, no merged prompt in history, and every uuid in history.
4. **Race at the end.** Send now just as a short reply finishes (ask for "OK", steer within 100 ms of the result). Expect carry-over or a normal turn, never a stuck `running` or a duplicate push.
5. **Interrupt / stop / crash.** Esc with a steer pending: the first turn is recorded as interrupted and the steer runs. Stop: both dropped, status stopped. Kill the manager mid-turn with a steer pending: after restart the steer is back at the front of the queue and the parent is notified once.
6. **Permission pending.** Use a Bash command that auto mode asks about, and Send now while the permission prompt waits. Expect the prompt to stay (and the steer to join after the tool, if allowed). If Claude Code cancels the prompt instead, the plan needs a rule: cancel our UI request.
7. **Images.** Send now a message with an image. The image shows live from `delivered`, the uploads file is deleted, and the image is in history after a reload.
8. **Expert with notify.** The orchestrator messages a busy expert, and the user does Send now on it (if allowed). Expect one notification for the turn, with the track's `replied` set.
9. **Fork / rewind** on a joined pair after the turn: fork from the steered prompt's turn, rewind to the steered prompt. Both resume fine.
10. **Keep-warm** after a joined turn: one episode, and pings start from the turn's cache.
11. UI: the hover buttons, the `Sending…` state, the Ctrl+Enter hint, and the `sent during the turn` meta, in light and dark at a narrow width.

## Later

- *Interrupt and send* (`priority: 'now'`) as Alt+Ctrl+Enter or a menu item.
- Show `detachedToolCall` tool calls ("stepped aside, result comes later").
- `message_expert` with `now: true`, so an orchestrator can steer its experts.
