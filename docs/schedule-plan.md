# Scheduled tasks: research and plan

Status: proposal (2026-11-08). Nothing here is implemented yet.

A **scheduled task** is a saved prompt that Centurion sends on a schedule: every morning at 9, on weekdays, every two hours, once next Monday, or only when you press **Run now**. This document compares how other apps do this, then proposes a design that fits Centurion's queues, permissions, keep-warm and state file.

## 1. How other apps do it

### Comparison

| | What a run targets | Where results show | Set up by | Missed runs (app or machine off) | Permissions when nobody watches | Limits, pausing, history |
|---|---|---|---|---|---|---|
| **OpenAI Codex app / ChatGPT scheduled tasks** (formerly Codex "Automations") [1][2] | Two kinds. *Standalone*: a new thread every run. *Thread* (in-chat) tasks: wake the same thread and keep its context ("heartbeat"). In git repos: the local checkout or a new worktree per run. | A **Scheduled** view that "acts as your inbox" (earlier: *Triage*), with an unread filter. Runs that need nothing from you can be archived (the earlier Codex docs archived them automatically when there was nothing to report). | Ask in a chat, or the schedule controls. Standalone tasks take an RRULE for advanced cases; thread tasks take minute intervals or daily and weekly times. Event triggers (Gmail, Slack, GitHub) on the web only. | Project tasks need the app running and the project on disk. No catch-up is documented: "if the app is closed, automations will not execute until it restarts" [3]. | Runs "use your default sandbox settings" with `approval_policy = "never"`: in read-only or workspace-write, a tool call that needs approval **fails** instead of waiting. Full access runs everything. | Active, paused, completed. Recent runs per task. Frequent worktree runs pile up and need archiving. |
| **Claude Code Desktop, local scheduled tasks** [4] | A **new session every run**, in the task's folder (current working tree, or an isolated worktree per run if you tick it). | A **History** list on the task's page (one row per run, including skipped ones with the reason), and an optional **Scheduled** group in the sidebar with the latest run per task. | A form (name, prompt, folder, permission mode, model; presets Hourly, Daily, Weekdays, Weekly, Manual, and Custom cron with a 1 hour minimum), or by asking Claude in any session ("set up a daily code review at 9am"; Claude may go below 1 hour and create one-time tasks). The prompt is stored as `~/.claude/scheduled-tasks/<name>/SKILL.md`. | Checked every minute while the app is open. On app start or wake it looks back **7 days** and starts **exactly one catch-up run for the most recently missed time**, with a notification; older misses are dropped. The docs warn that a 9 am task may then run at 11 pm, and suggest time guardrails in the prompt. | A permission mode per task, plus the allow rules from `~/.claude/settings.json`. A run that hits a prompt **stalls** until you open its session and answer; the advice is to **Run now** once and "always allow" what it asks. Users report stalls without a notification [5]. | Active / Paused toggle, Run now, Edit, Delete (run sessions are archived, not deleted). Skipped when the computer slept, the previous run was still going, or other tasks were running. A small deterministic delay per task staggers API traffic. |
| **Claude Code cloud scheduled tasks** (formerly Routines) [6] | A **new cloud session every run** (fresh clone, `claude/` branches). Inside a Claude *project*, a run can continue an existing thread instead. | History on the task's page; each run opens as a full session. Row status says only how the session ended (Succeeded, Failed, Cancelled), not whether the work got done. | Web form, desktop app, or `/schedule` in the CLI ("/schedule daily PR review at 9am"). Presets plus custom cron (no more often than hourly), one-off runs, API and GitHub triggers. | Runs in the cloud, so the machine doesn't matter. Runs over the hourly cap wait until it resets. | Each run starts in **auto mode**; what auto mode still asks (ask rules, repeated blocks) **waits in the run's session** until someone answers. The fired prompt "can't act as approval or consent" for actions during the run. | 100 scheduled runs per hour per account, 30 Run now / API fires per task per hour. On/off switch to pause. Ask `/schedule` why a run did nothing. |
| **ChatGPT Tasks** (consumer) [7][8][2] | A task made in a chat returns to **that chat** with its context; tasks made on the Scheduled page start a new chat per run. | Push and email notification when a run finishes (configurable per channel), and the **Scheduled** page. | Natural language in a chat ("every Monday…"), then edit name, instructions and schedule from the Scheduled page or the task pill in the chat. | Cloud; not affected. | No local tools; runs use the account's normal tools. | 10 active tasks (3 to 15 by plan, per later coverage); pause or delete from the Scheduled page. Plan usage limits apply. |
| **Cursor Automations** (Cloud Agents) [9][10] | A **new cloud agent run** each time. A repository, several, or none (with none it can't edit code or open PRs). | The run's page; results go where the automation's tools send them (PR comments, Slack). Cursor does not notify on some failures (an MCP server rejecting credentials). | Agents window or cursor.com/automations: trigger (schedule as presets or cron; GitHub, Slack, Linear, PagerDuty, webhook), prompt, tools, repos. Several triggers per automation. | Cloud. Scheduled triggers "may start late, but never before the set time." | Unattended by construction: only the tools you pick (comment on PR, Slack, MCP, memories), run as you or a service account. Warns that untrusted input can poison memories. | Billed at API prices per run. Team admins can disable shared automations. |
| **Claude Code `/loop` and the Cron tools** [11] | The **same session**: the prompt is queued between turns, at low priority. | In the session itself. | `/loop 5m <prompt>`, a self-paced `/loop` (Claude picks 1 min to 1 h after each run), or "remind me at 3pm…" through `CronCreate` / `CronList` / `CronDelete` (5-field cron, local time). | **No catch-up.** A run that comes due while Claude is busy fires once when it's idle, not once per missed interval. Restored on `--resume`, but missed runs are skipped. Recurring tasks expire after 7 days. | Inherits the session's mode. | 50 tasks per session. Jitter: recurring runs start up to half the gap late (at most 30 min); one-shots on :00 / :30 run up to 90 s early. `CLAUDE_CODE_DISABLE_CRON=1` turns it off. |

### What this says for Centurion

- **Two targets are normal.** Every product with local or chat context offers "a new session each run" for independent jobs (reviews, audits, briefings) and "wake this thread" for monitoring that should remember the last run (Codex thread tasks, ChatGPT in-chat tasks, `/loop`, Claude projects). Centurion should offer both, with a new chat as the default.
- **Results go to an inbox with unread.** Codex has the Scheduled inbox, Desktop the History list plus a sidebar group. Centurion already has this: an unread reply puts a chat in **Needs you**. A run only has to produce a chat (or a turn) with an unread reply.
- **Missed runs: one catch-up, the latest only.** Claude Desktop does exactly the user's lean ("run once at startup"), limited to the last 7 days, with a notice, and tells the prompt-writer that the run may be late. Codex and `/loop` simply don't catch up. So "run once at startup" is well supported; the refinements worth copying are the 7-day look-back, collapsing many misses into one, and telling the agent that the run is late.
- **Permission stalls are the known weak spot.** Desktop and cloud tasks wait on prompts in the run's session (and users complain that nothing tells them); Codex refuses instead (`approval_policy = "never"`). Centurion's prompts wait indefinitely, so a run needs an explicit policy (section 2.6).
- **Runs don't overlap.** Desktop skips a run when the previous one is still going and records why; `/loop` folds missed fires into one. Skips belong in the history with a reason.
- **Creating by asking is expected** (Desktop, `/schedule`, ChatGPT), but every one of them also has a form and a list page.

## 2. Recommended design

### 2.1 The task

A scheduled task has a name, a prompt, a **target**, a **schedule** and a few policies:

- **Target: a new chat each run** (default). Each run creates a chat in the task's folder (default `orchestratorFolder`), with the task's model and effort, named `<task> · Nov 8, 09:00`. The run chats are grouped under the task in the sidebar. Fresh context, no growing session, nothing else is held up.
- **Target: an existing agent** (a chat, or an expert). Each run is one queued message to that agent. For monitoring that should remember the last run ("check the release branch's CI again and tell me what changed since last time"). The agent's context grows with every run; the task page says so.
- **Schedule**: presets (every *n* hours, daily at, weekdays at, weekly on days at), **once at** a time, **manual only** (a saved prompt with Run now), and **custom cron** (5 fields, local time). Nothing more often than every 15 minutes; `/loop` inside the agent covers faster polling.
- **Catch-up** (default on): see 2.4.
- **When it needs permission** (`unattended`): see 2.6.
- **Keep runs** (new-chat target, default 5): older run chats are archived automatically.

Runs are not jittered (one user, one machine), but at most `scheduleMaxRunning` (default 2) runs are started at once; the rest wait their turn in the scheduler, which spreads a burst at 9:00 or at startup.

### 2.2 What a run sends

A run's message has a new source, `schedule`, and a prefix the UI parses like the orchestrator prefix:

```
[Scheduled task "daily-review" · due Sat Nov 8 09:00 · started 09:00]
<the task's prompt>
```

A catch-up run says `· catch-up: due Sat Nov 8 09:00, started 14:12`, so the prompt can carry Desktop-style guardrails ("if it's after 17:00, only summarize"). The `QueuedMessage` carries `schedule: { taskId, runId }`, which links the turn back to the run.

`schedule` messages are **not** held by a notification pause (that pause is for expert notifications; `isHeld` stays `source === 'manager'`) and never `notify` a parent: a scheduled run in an expert is like a message the user sent.

### 2.3 Queues, overlap and "one message per turn"

Nothing changes in `AgentRuntime`: a run is one queue entry and one turn.

- **Existing agent.** The run is enqueued behind whatever is queued; if the agent is running, it waits for the turn to end. If an earlier run of the same task is still queued (not delivered), the new one is **skipped** (`previous run still queued`), so a busy agent never piles up copies. A stopped or failed agent resumes as usual on the message. A run that waits behind a permission prompt shows as `queued` in the history.
- **New chat.** If the previous run's chat is still running or waiting on a permission, the new run is **skipped** (`previous run still running`), like Desktop.
- Removing a queued run message (the queue's remove button) or stopping the agent marks the run `cancelled`. Interrupting marks it `interrupted`. A run whose agent was mid-turn when the manager restarted becomes `interrupted` (the existing `recover` path) and is not retried.

### 2.4 Missed runs: one catch-up, latest only

The scheduler doesn't trust one long `setTimeout` (Windows sleep and clock changes delay or skip them). It keeps each task's `nextAt` in the state file and **ticks every 30 seconds**: any active task with `nextAt <= now` is due. That one rule covers startup, waking from sleep and normal runs:

- If only the current occurrence is due (it's less than a tick late), it's a normal run.
- If one or more occurrences were missed (the manager was off, the machine slept), the task gets **one catch-up run** for the **most recent** missed time, provided that time is within `scheduleCatchUpDays` (default 7); older ones are dropped and recorded as a single `skipped · missed while Centurion was off (3 runs)` history row. `nextAt` then moves to the next future occurrence.
- Catch-up runs at startup wait `scheduleStartupDelaySeconds` (default 60) so the manager, the SSE clients and the restored agents settle first, then go out through the same `scheduleMaxRunning` limit.
- A task with **catch-up off** just records the miss and waits for the next occurrence (Codex / `/loop` behaviour). A **once** task that was missed runs once as a catch-up (if within the window) and then becomes `done`.

This is the user's lean ("run once at startup") with Desktop's refinements: only the latest miss, a look-back limit, a history row for what was dropped, and the agent told it's late.

### 2.5 Keep-warm

A scheduled run is a turn, so keep-warm sees it like any other: no pings while the run is queued or running (the existing `deliverable(rec).length` check). Two changes:

- **A scheduled turn doesn't start a keep-warm episode.** Nobody is watching, so pinging for 45 minutes or 8 hours after a 3 am run is waste. The reply gets `scheduled: true`, and `KeepWarm.plan` returns no ping while the last reply is a scheduled one (the next user turn starts episodes again).
- New run chats get no keep-warm settings. For an existing-agent task that runs more often than the cache TTL (hourly on a 1 h cache), the run itself keeps the cache warm; the task page can say `runs within the cache's lifetime`.

### 2.6 Permissions while you're away

Auto mode already decides most calls. For what it can't decide, each task has a policy for the turns it starts (`unattended`):

- **Deny and continue** (recommended default). The request is denied at once with the message *"This is a scheduled run and nobody is watching. Skip this step, and say in your reply what you needed permission for."* The request still shows as a step line (`denied: scheduled run`) and the run's history row counts it (`2 permissions denied`). This is Codex's behaviour, and it means a run always ends.
- **Ask and wait.** The request waits like any other (the current behaviour): the agent shows in Needs you with `Needs permission`, and the run stays `running`. Right for runs you expect to watch.

The policy applies only while the agent's current message is a scheduled one (`rec.current.schedule`), so an existing chat keeps its normal behaviour the rest of the time. "Allow for this session" rules the user granted earlier still apply, and allow rules in the folder's or user's settings keep working; the task page suggests running it once with **Run now** while watching, as Desktop does.

### 2.7 Archived agents and deleted targets

- **Existing-agent target archived**: the run doesn't go out (it would unarchive the chat, which the user archived on purpose). The task shows `Paused · its chat is archived` and the history records `skipped · chat archived`. Unarchiving the chat lets runs continue.
- **New-chat runs**: after a run ends, run chats beyond `keepRuns` that are idle, not queued and not waiting on a permission are archived (with their experts), newest kept. They stay findable in the switcher and under the task's history.
- A task whose folder no longer exists fails its run with that error (from `buildOptions`), shown on the task row.

### 2.8 Creating tasks by asking

Chats get a `schedule_task` tool (and `list_scheduled_tasks`). It doesn't start anything: it creates the task as **proposed**, rendered in the transcript as a decision block, like a track plan: the name, the schedule in words with the next three times, the target and the prompt, and **Activate** (primary) and **Edit** buttons. Activating is a UI action, so a model can never set up unattended work on the user's usage by itself, and decisions don't mix with chat (Activate doesn't send a message). An agent can pause or list tasks, not activate or delete them.

### 2.9 Where results show

- **Needs you**: a run chat with an unread reply is already a chat whose reply you haven't read, so it shows there with no new rule. An existing agent's run reply makes it unread the same way. A failed run (error, cancelled by a restart) adds the task row to Needs you (`Last run failed`) until you open it.
- **"Nothing to report"** (later, see open questions): a run whose reply is exactly `Nothing to report.` could be marked quiet, archived at once and kept out of Needs you, like Codex's inbox.
- **The tab title and favicon** count Needs you as today; no separate notification system (configurable notifications are a later item in CLAUDE.md).

## 3. UI

Follows `docs/ui-design.md`: colour only with meaning, no new surface types.

- **Sidebar: a `Scheduled` group** below the chats and above `Archived`, its header in the same 11.5 px mono `--text-3` as the other group headers, with a **+** on hover. Each task is a row with a clock glyph in a sunken 22 px mark (tasks aren't agents, so no identity hue), the name, and a second line: `Daily 09:00 · next in 3h`, `Weekdays 09:00 · running`, `Paused`, `Proposed · activate in test2`, or `Last run failed` in coral with a coral dot on the mark. New-chat runs sit under the task on the hairline like experts under a chat (latest `keepRuns`), so the latest result is one click away. Rows for existing-agent tasks have no children; their second line links nothing, the task page does.
- **Task page** (a pane kind next to an agent view, so it works in split view): a two-line header (`Scheduled · daily-review`, then `Active · next run Mon 09:00`), the actions **Run now** (primary), **Pause / Resume**, **Edit**, and `⋯` (Duplicate, Delete). Below: the schedule in words with the next three times in mono, the target (a chat link or `New chat in centurion`), the policies, the prompt as a `--fill` message block, then **History**: one hairline row per run, newest first: time in mono, `Catch-up` / `Run now` tag in `--text-3`, the outcome sentence (`Replied after 1m 12s · $0.04`, `Skipped · previous run still running`, `Failed · <error>`, `2 permissions denied` in `--waiting`), and a link that opens the run's chat or scrolls the agent to that turn (by the prompt uuid). States use the state hues; nothing else is coloured.
- **Create / edit form**: opened from the group's **+**, the sidebar's top **+** menu (`New scheduled task`), and a chat's or expert's `⋯` menu (`Schedule a message…`, which preselects that agent as the target). Fields: name, prompt (the composer's text field, with `/` skills and `@` mentions), target (`New chat each run` in a folder from the recent-folders list, or `This agent`), schedule (preset select + time and day pickers, or a cron field), model and effort (the existing picker; new-chat target only), and an `Advanced` fold for catch-up, the permission policy and keep runs. A live line under the schedule shows the next three run times from the server (`/api/schedules/preview`), or the parse error in coral. The primary button is **Create** (active) and the secondary **Create paused**.
- **Transcript**: a scheduled message's speaker line is a clock mark and `Scheduled · daily-review · 09:00` (`Catch-up · due 09:00` when late), the text block as usual, with the prefix hidden like the orchestrator prefix. A proposed task (from `schedule_task`) is a decision block in the turn, built like a plan (raised surface, plan head and foot); once activated it collapses to one line linking to the task page.
- **Overview**: a `Next runs` list (task, target, time) under the summary row, and `Scheduled runs today` in the recent replies.
- **Narrow width**: the task page stacks; the history rows drop the cost.

`docs/ui-design.md` gets a section **6b. Scheduled tasks** with these rules, and the sidebar list in section 2 gains the group.

## 4. Alternatives rejected

- **Only "existing agent" (like `/loop`).** Cheap and simple, but a daily task's context grows without end, and it holds up the user's own work in that chat. Kept as the second target, not the only one.
- **Only "new chat each run".** Loses the monitoring case (Codex thread tasks, ChatGPT in-chat tasks); kept as the default instead.
- **Use Claude Code's own `CronCreate` / `/loop` in the agents.** Session-scoped, expires after 7 days, fires only while that process is alive, and Centurion closes idle processes after `idleMinutes`. It also bypasses Centurion's queue, so its runs would be invisible to keep-warm and the UI. The agents can still use `/loop` themselves.
- **Running every missed occurrence, or never catching up.** Every-occurrence floods the agent after a weekend off and repeats the same work; no catch-up loses the 9 am briefing whenever the laptop was closed at 9. One catch-up for the latest miss is what Desktop does.
- **An OS scheduler (Windows Task Scheduler, cron) that starts Centurion.** Centurion only runs as a long-lived server and agents need its UI for permissions; out of scope while it runs only when started (the dev container plan may revisit this).
- **Permission policy "wait" as the default.** That is Desktop's behaviour and its most reported complaint; a 3 am run would block until morning, and an existing chat's queue with it.
- **Let `schedule_task` activate directly.** Desktop allows it, but that lets a model start recurring work on the user's usage unasked; a proposal block matches how plans work here.
- **Storing tasks as files (Desktop's `SKILL.md`).** Editable outside the app, but the state file is the one source of truth here and only the manager writes it; a file per task would need watching and merging.
- **Jitter.** It protects a shared API from millions of 9:00 runs; for one user the concurrency limit is enough and runs stay predictable.

## 5. Backend changes, per file

- **`src/types.ts`**: `MessageSource` gains `'schedule'`; `QueuedMessage.schedule?: { taskId; runId }`; `Reply.scheduled?: true`; new types:
  ```ts
  type ScheduleSpec =
    | { kind: 'cron'; cron: string }          // presets compile to cron; `label` keeps the preset's words
    | { kind: 'once'; at: string }
    | { kind: 'manual' };
  type ScheduleTarget =
    | { kind: 'newChat'; cwd: string; model: string | null; effort: EffortLevel | null }
    | { kind: 'agent'; agentId: string };
  type ScheduledTask = {
    id: string; name: string; prompt: string;
    target: ScheduleTarget; schedule: ScheduleSpec;
    status: 'proposed' | 'active' | 'paused' | 'done';
    catchUp: boolean; unattended: 'deny' | 'ask'; keepRuns: number;
    nextAt: string | null;               // the next occurrence; the scheduler's only clock
    runs: ScheduledRun[];                // newest last, last 50
    proposedBy?: { agentId: string; toolUseId?: string };
    createdAt: string; updatedAt: string;
  };
  type ScheduledRun = {
    id: string; dueAt: string; trigger: 'schedule' | 'catchUp' | 'manual';
    status: 'waiting' | 'queued' | 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled' | 'skipped';
    reason?: string;                     // why skipped or failed
    missed?: number;                     // occurrences dropped in favour of this catch-up
    agentId?: string; messageId?: string; promptUuid?: string;
    startedAt?: string; endedAt?: string; durationMs?: number; costUsd?: number;
    denied?: number; preview?: string;
  };
  ```
  `AgentRecord.scheduleId?: string` on run chats (groups them in the sidebar). `StateFile` gets `version: 2` and `schedules: ScheduledTask[]`.
- **`src/state.ts`**: `STATE_VERSION = 2`; `MIGRATIONS[1] = (d) => ({ ...d, schedules: [] })`. The bump matters: an older Centurion would otherwise load a newer file, ignore `schedules` and drop them on its next write; now it refuses the file. `State` gains `schedules`.
- **`src/cron.ts`** (new): parse and validate 5-field cron (numbers, `*`, steps, ranges, lists; vixie day-of-month / day-of-week OR rule), `nextAfter(spec, date)` in local time, `occurrencesBetween` (bounded count, for catch-up), `describe(spec)` (`Weekdays 09:00`), the 15-minute minimum check, and the presets. Either written in-house (about 150 lines; DST is the risky part and gets tests) or a thin wrapper over `croner` (MIT, no dependencies). Recommended: `croner`, to not own DST edge cases; the rest of the file is ours either way.
- **`src/schedule.ts`** (new): `Scheduler`, modelled on `KeepWarm`: hooks (`tasks()`, `startRun(task, run)`, `changed(task)`), a 30 s `unref`'d tick, the due / catch-up / skip rules of 2.4, the startup delay, and the `scheduleMaxRunning` limit (a small waiting list of `waiting` runs). Pure decisions (`dueRuns(task, now, opts)`) are separate functions so tests can drive them with fake clocks.
- **`src/manager.ts`**: holds `schedules` (load, save in `state()`), CRUD (`createSchedule`, `updateSchedule`, `setSchedulePaused`, `activateSchedule`, `deleteSchedule`, `runScheduleNow`, `previewSchedule`), and `startRun`: for `newChat`, `createAgent('orchestrator', …)` with `scheduleId` and the task's model and effort, then `sendMessage(…, 'schedule')`; for `agent`, the overlap and archived checks, then `sendMessage`. `sendMessage` takes the `schedule` link and skips `unarchive` for schedule messages (the archived check happened before). Hooks: `onDeliver` → run `running` with the prompt uuid; `onTurnEnd` → run `done` / `failed` / `interrupted` with duration, cost and a preview, sets `reply.scheduled`, then archives old run chats (`keepRuns`); `removeQueued` and `stop` → `cancelled`; `recover` → `interrupted`. `askPermission`: when `rec.current?.schedule` points to a task with `unattended: 'deny'`, resolve at once with the deny message and count it on the run. `setArchived` on an agent that is a task target re-plans the task (shows paused). A new `schedule` event per change.
- **`src/keepwarm.ts`**: `plan()` returns no ping while the agent's last reply is `scheduled`.
- **`src/tools.ts`**: `schedule_task` (name, prompt, schedule as `{ preset, time, days }` or `cron` or `once_at`, target `new_chat` with folder or `this_chat` or an expert id, model, effort; returns the task id and the next three times; status `proposed`), `list_scheduled_tasks`, `pause_scheduled_task`. Their descriptions say activation is the user's.
- **`src/server.ts`**: routes `GET /api/schedules`, `POST /api/schedules` (create; `{ …, paused? }`), `POST /api/schedules/:id` (update), `POST /api/schedules/:id/pause` (`{ paused }`), `POST /api/schedules/:id/activate`, `POST /api/schedules/:id/run` (Run now), `DELETE /api/schedules/:id` (run chats stay, unlinked), `GET /api/schedules/preview?cron=…|once=…` (next times or the error). SSE: `schedule` (a task changed; `{ deleted: true, id }` on delete), and the snapshot sends all tasks like plans. `npm run check:docs` covers them.
- **`src/config.ts`**: `schedules` (boolean, default `true`: off stops the scheduler, Run now still works), `scheduleCatchUpDays` (default 7, 0 = never catch up), `scheduleStartupDelaySeconds` (default 60), `scheduleMaxRunning` (default 2).
- **`src/docs.ts`, `guide/agent.md`, `README.md`**: the tools list renders from `managerTools`; the agent guide gets a paragraph on scheduled tasks; the README a line in usage.
- **`prompts/orchestrator.md`**: one sentence: to repeat work on a schedule, propose it with `schedule_task`; the user activates it.

## 6. UI changes, per file

- `ui/src/api.ts`: schedule calls and types.
- `ui/src/store.ts`: a `schedules` map fed by `snapshot` and the `schedule` event.
- `ui/src/layout.ts`: a pane can show a task (`{ kind: 'schedule', id }`) as well as an agent.
- `ui/src/Sidebar.tsx`: the `Scheduled` group, task rows, run chats nested under their task (and left out of the chat tree), the `+` menu item, and `Schedule a message…` in row menus.
- `ui/src/ScheduleView.tsx` (new): the task page and its history. `ui/src/ScheduleForm.tsx` (new): create and edit, with the live preview.
- `ui/src/Header.tsx`: `Schedule a message…` in the `⋯` menu.
- `ui/src/timeline.ts`: parse the `[Scheduled task …]` prefix into a `schedule` sender (name, due, catch-up) and hide it.
- `ui/src/Transcript.tsx`: the scheduled speaker line; the proposed-task decision block (or a small `ScheduleProposal.tsx`), collapsed once activated; `denied: scheduled run` on step lines.
- `ui/src/status.ts`: Needs you includes failed-run tasks and proposed tasks (in their chat); the status line of a task row; `isHeld` unchanged.
- `ui/src/tabStatus.ts`: counts those Needs you rows.
- `ui/src/App.tsx` (Overview): `Next runs`.
- `ui/src/icons.tsx`: the clock and calendar glyphs.
- `ui/src/styles.css`: task row and history row styles from existing tokens; no new colours.
- `docs/ui-design.md`: section 6b and the sidebar line in section 2.

## 7. Implementation steps

Each step is a commit; backend steps are usable through the API before the UI exists.

1. **Types, state v2, config.** `src/types.ts`, `src/state.ts` (migration 1 → 2), `src/config.ts`; `npm run typecheck`, `check:docs`.
2. **`src/cron.ts`** with presets, validation, `nextAfter`, `describe`, and unit tests (`node --test` via tsx) including DST days and the 15-minute minimum.
3. **`Scheduler`** (`src/schedule.ts`) with the due / catch-up / skip decisions as pure functions and tests with a fake clock.
4. **Manager wiring**: CRUD, `startRun` for both targets, run status from deliver / turn end / remove / stop / recover, `keepRuns` archiving, `reply.scheduled`, keep-warm change.
5. **Unattended permissions** in `askPermission` and the denied counter.
6. **Routes and SSE** in `src/server.ts`, docs check.
7. **Tools** (`schedule_task`, `list_scheduled_tasks`, `pause_scheduled_task`), prompt sentence, agent guide.
8. **UI: store, sidebar group, task page with history, Run now / pause.**
9. **UI: form with preview**, the `⋯` entries.
10. **UI: transcript speaker line, proposal block, Needs you, overview**, and `docs/ui-design.md` 6b.
11. **README** and the CLAUDE.md layout and design-decision lines.

## 8. Test plan

Use a scratch config, port and state file, as CLAUDE.md says, and tiny prompts ("Reply with the word ok.").

- **Unit (no agents):** cron parsing and errors; `nextAfter` across month ends, leap days and both DST changes (Europe/Brussels); presets → cron → `describe`; the 15-minute minimum. Scheduler decisions with a fake clock: on time; one missed → one catch-up; ten missed → one catch-up with `missed: 9`; a miss older than `scheduleCatchUpDays` → skip row only; catch-up off; `once` missed and caught up → `done`; paused tasks never due; startup delay; `scheduleMaxRunning` holding the third run as `waiting`.
- **State:** a version-1 file loads with `schedules: []` and is written as version 2; a version-3 file is refused; an older build refuses a version-2 file.
- **New-chat target (real agent):** a task `*/15` or Run now creates a chat with `scheduleId`, the prefix and the right model; the run goes `queued → running → done` with cost and preview; the chat shows unread in Needs you; with `keepRuns: 2`, a third run archives the oldest; a run while the previous chat is still running (a prompt that sleeps briefly with a `Bash` call) is skipped with the reason.
- **Existing-agent target:** a run while the agent is mid-turn queues behind it (one message per turn: two results, two turns); a second due run while the first is still queued is skipped; removing the queued run → `cancelled`; Stop → `cancelled`; Esc → `interrupted`; archiving the target → task shows paused and runs skip; unarchive → runs continue; with notifications paused on that chat, the scheduled message is still delivered and held notifications stay held.
- **Missed runs:** stop the manager, move the task's `nextAt` back two hours in the state file (or wait past one occurrence), start: after the startup delay exactly one catch-up run goes out with the `catch-up` prefix and one skip row. Repeat with catch-up off. Sleep the laptop over an occurrence: one catch-up after wake on the next tick.
- **Restart mid-run:** kill the manager during a run's turn; on start the agent is `interrupted`, the run is `interrupted`, and nothing is retried.
- **Permissions:** with `unattended: 'deny'`, a prompt asking for something auto mode won't decide (e.g. a write outside the folder) is denied at once, the step line says so, the reply mentions it, the run counts `denied: 1`, and no permission block waits. With `ask`, the block appears and the agent sits in Needs you. Outside scheduled turns the same chat still asks.
- **Keep-warm:** with keep-warm on for an existing-agent target, no ping is planned after a scheduled turn, and after the next user turn pings resume.
- **Tools:** `schedule_task` from a chat creates a `proposed` task (not run), the proposal block shows the next times, Activate makes it active without sending the chat a message; `pause_scheduled_task` works; no tool can activate or delete.
- **UI:** the group, task page, history rows and form in light and dark and at a narrow width; the task page in split view; the cron preview error; the transcript speaker line for normal and catch-up runs; tab title count with a failed run.

## Sources

1. OpenAI, *Scheduled tasks / Automations* (Codex app surface): https://learn.chatgpt.com/docs/automations?surface=app (redirected from https://developers.openai.com/codex/app/automations).
2. OpenAI Help Center, *Scheduled tasks in ChatGPT*: https://help.openai.com/en/articles/10291617 (limits, Scheduled page, pause and delete; read through search excerpts, the page refused direct fetching).
3. Daniel Vaughan, *Codex as a proactive teammate: thread automations, scheduled monitoring*: https://codex.danielvaughan.com/2026/05/15/codex-proactive-teammate-thread-automations-scheduled-monitoring-durable-views/ and *Mastering the Codex desktop app: automations, triggers and the review queue*: https://codex.danielvaughan.com/2026/04/08/codex-desktop-automations/ (secondary).
4. Anthropic, *Schedule recurring tasks in Claude Code Desktop*: https://code.claude.com/docs/en/desktop-scheduled-tasks
5. User reports: *Scheduled tasks stall silently on permission prompts*: https://claudeissues.com/issue/76340-scheduled-tasks-stall-silently-on-permission-prompts-no-error-no-notification-re ; *"Always allow" missing from permission prompts*: https://github.com/anthropics/claude-code/issues/33027 (unverified reports).
6. Anthropic, *Automate work with scheduled tasks* (cloud, formerly Routines): https://code.claude.com/docs/en/routines
7. Zapier, *How to use ChatGPT scheduled tasks*: https://zapier.com/blog/chatgpt-scheduled-tasks/ (notifications, setup, 3 to 15 active tasks).
8. TechRadar, *ChatGPT Tasks…*: https://techradar.com/computing/artificial-intelligence/chatgpt-tasks-can-start-taking-over-your-calendar-and-remind-you-to-finish-your-to-do-list (launch coverage).
9. Cursor, *Automations*: https://cursor.com/help/ai-features/automations
10. Cursor changelog, 2026-03-05: https://cursor.com/changelog/03-05-26 ; Help Net Security, *Cursor Automations turns code review and ops into background tasks*: https://www.helpnetsecurity.com/2026/03/06/cursor-automations-turns-code-review-and-ops-into-background-tasks/
11. Anthropic, *Run prompts on a schedule* (`/loop`, Cron tools): https://code.claude.com/docs/en/scheduled-tasks
