# UI design: "quiet instrument"

The design language and the main UI patterns of the agent manager. All UI work follows this guide. It replaces the v1 look (a VS Code clone with default styling: blue selection, uppercase labels, raw paths, tinted message boxes with a coloured left border). Where a pattern needs data the backend lacks, the section says so.

How to use it:
- **The rules here are the source of truth; the code holds the values.** Once a step is implemented, `ui/src/styles.css` is where colours, sizes and radii live. This guide keeps the rules (what each surface and colour is for, what to avoid) and should not repeat values that already exist in the CSS.
- **The mockups are a sketch, not a spec.** [Design canvas](https://claude.ai/artifact/ABUojRVXjKyeR8j5vc1ohJ): orchestrator view in dark, a running expert in light with the model picker open, the overview, the design language sheet, a track plan before and after Start, and a question set. The data in them is sample data. When the real UI and the mockup disagree, for example spacing that feels cramped with real transcripts, fix the UI sensibly and update this guide, not the canvas.
- **Keep it current.** When a change alters a rule or a pattern here, update this guide in the same commit, and mark the step done in the implementation plan (the last section).

## 1. Direction

**A calm control room for a team of agents.** The app is a place where you supervise several agents at once, so it should read like an instrument: quiet chrome, dense where it helps, and loud only when something needs you.

Three ideas carry the design:

1. **Colour always means something.** The chrome is warm graphite (dark) or warm paper (light). Colour comes in three kinds, and each says one thing:
   - **State**: blue, green, amber and coral, only for running, done, waiting and failed.
   - **Action**: one aqua accent for what you can act on: the selected row, focus rings, the send button, primary buttons, links and checkboxes. Never for state, never as decoration.
   - **Identity**: the same six hues tell agents apart. An expert's mark is tinted in its repo's hue (and so is the repo name on delegations), so experts in one repo share a colour; a chat's mark is filled in a hue from its name. You recognise agents without reading. Never a dot, since dots are state.

   The first version had state colour only, and with nothing running the whole app read as gray. Purple may appear among the identity hues, but it is not the app's theme colour.
2. **The transcript is a document, not a chat log.** Agent prose sits in a centred reading column with no container. Tool calls collapse into one "worked for 18s" line per run of steps. Only messages *into* the agent and links to other agents get a surface.
3. **The hierarchy is the product.** Delegations to experts are live objects in the orchestrator's transcript, the sidebar is a team roster, and moving between parent and child is one click or `Alt+←`. No other agent UI does this well (see `ui-research.md`).

What it deliberately avoids: coloured left borders, a tinted box per role, cards around everything, gradient or "AI sparkle" decoration, emoji status, ALL CAPS labels, pill badges on every row, VS Code's blue-on-grey, and a purple theme.

## 2. Layout

```
┌──────────────────────┬──────────────────────────────────────────────────────┐
│ Agent manager      + │ [TS] test2 / [RS] restaurant-summary   restaurant  $0.009  ◔ 3%  ⋯ │
│ ⌕ Search or jump  ^K │ Idle · replied 4 min ago                                │
│                      │──────────────────────────────────────────────────────│
│ Needs you            │           ┌ You · 11:20 ───────────────────┐          │
│  [WC] web-checkout ● │           │ Gather some basic stats…       │          │
│                      │           └────────────────────────────────┘          │
│ checkout-redesign    │           ⌄ Worked for 18s · 3 commands               │
│  │ [AC] api-contracts│           Project stats …prose…                       │
│  │ [WC] web-checkout │           Done in 42s · $0.004                        │
│ test2                │                                                       │
│  │ [RS] restaurant…  │           ┌──────────────────────────────────┐        │
│                      │           │ Message restaurant-summary        │        │
│ 2 running · $1.24    │           │ Enter to send          [■] [↑]   │        │
└──────────────────────┴───────────┴──────────────────────────────────┴────────┘
```

- **No activity bar** until there is a second view. When Files or Tasks arrive, they become a small segmented control at the top of the sidebar.
- **Sidebar (264 px)**, one step darker than the main area, so it recedes. From top to bottom: app name and **+**, a search field that opens the Ctrl+K switcher, a **Needs you** group (only when non-empty), then the orchestrators with their experts indented beneath on a hairline, and a footer with global counts and spend. **Needs you** holds what is waiting on you: failed or interrupted agents, orchestrators whose last reply you haven't read (it is your turn; an expert's reply goes to its orchestrator, not to you), and later plans and question sets. Rows there repeat the tree's rows with the time on the right. The search field opens a switcher (`Ctrl+K` from anywhere) that finds agents by name, folder or orchestrator.
- **Archiving.** Hovering a row shows an archive button next to its expander; right-clicking a row opens a small menu (Open, Open in split, Archive). Archived experts of a live chat sit in a folded `Archived · n` row under the chat. Archived chats go to one folded `Archived · n chats` group at the bottom of the tree, below a hairline, each folded with its experts; their rows are dimmed. The switcher still finds them.
- **Main area**: a two-line header, the transcript in a centred column (max 760 px of prose), and a floating composer.
- **Split view**: the main area holds one or two panes, each a full agent view. Drag a sidebar row onto the main area (the outer thirds split, the middle replaces; when already split, each half replaces its pane), use **Open in split** in the row menu, or Shift+Enter in the switcher. While dragging, an `--accent-soft` zone with a hairline shows where it lands. The focused pane gets the keyboard (Esc, Alt+←, Ctrl+O) and the sidebar's selected wash; the other pane's agent gets a fainter wash, and that pane's title and status step back to `--text-3`. A divider between the panes resizes them (double-click resets it), and each header gets a close button. Panes narrower than 620 px get the narrow header (no cost, folder chip or context number). The layout is per browser.
- **Narrow (< 900 px)**: the sidebar becomes a drawer opened from a menu button in the header; the composer spans the width. A split shows one pane at a time, with a switch between the two above it.
- **No agent selected**: an **Overview** instead of the empty welcome text (section 6).

## 3. Visual language

### Colour

Warm neutrals; avoid blue-grey. The values below are the starting point for step 1; after that, the theme variables in `ui/src/styles.css` are authoritative and this table can shrink to the token names and their use.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--canvas` | `#161514` | `#FBFAF8` | Main area |
| `--sunken` | `#111110` | `#F3F1EE` | Sidebar, code blocks |
| `--raised` | `#1F1E1C` | `#FFFFFF` | Composer, menus, delegation objects |
| `--fill` | `#252422` | `#E9E6E1` | Hover, your messages, selected row |
| `--line` | `#2A2926` | `#E4E1DC` | The few hairlines left |
| `--text` | `#ECEAE6` | `#1C1B19` | Primary text |
| `--text-2` | `#B3AFA8` | `#5E5A54` | Secondary text |
| `--text-3` | `#8A867F` | `#6F6B64` | Meta, timestamps (still ≥ 4.5:1) |
| `--running` | `#6AA8FF` | `#1F6FEB` | Running, in progress |
| `--done` | `#63C98A` | `#1E8A4C` | Finished with an unread reply |
| `--waiting` | `#E8B04A` | `#9A6200` | Queued, interrupted, a plan waiting for you |
| `--failed` | `#FF7A6B` | `#C2392A` | Failed, denied, errors |
| `--accent` (+ `-text`, `-soft`, `-line`, `--on-accent`) | aqua | deep teal | What you can act on: selection, focus, send, primary buttons, links |
| `--id-0` … `--id-5` (`-bg` / `-fg`) | rose, plum, clay, steel, lavender, sand | same, light tints | Expert marks by repo (`repoHue()`), chat marks by name (`nameHue()`), both in `status.ts`; `--id-on` is the text on a filled chat mark |

The dark surfaces step further apart than the first values above (see `styles.css`), so the sidebar, your messages and raised objects separate by tone alone. Keep identity hues away from the state hues (no green, blue, amber or coral, and no teal next to the accent).

Primary buttons and the send button are the accent with `--on-accent` text. An empty composer's send button stays readable (`--fill-2`), not faded. The focus ring is a 2 px accent outline at 70 % with a 2 px offset; the composer gets a 1 px accent ring while focused.

### Type

- **IBM Plex Sans** for UI and prose, **IBM Plex Mono** for code, paths, costs, durations and token counts. Both bundled with `@fontsource` (the app runs offline). Fallback: `Segoe UI Variable`, `system-ui`.
- Numbers use tabular figures, so costs and timers don't jitter.
- Scale: 11.5 (mono meta), 12.5 (secondary), 13.5 (UI), 15 / 1.65 (prose), 17 (agent title), 24 (overview headings). Weights 400, 500 and 600 only.
- Sentence case everywhere. The only small caps-like label is the sidebar group header, set in 11.5 px mono at `--text-3`, not uppercase sans.

### Space, shape, depth

- 4 px grid. Sidebar rows 30 px (two-line rows 44 px), header 64 px, transcript blocks 20 px apart, turns 32 px.
- Radii: 6 px controls, 10 px objects, 14 px composer, full for status dots.
- Depth comes from surface tone, not borders. Shadows only on things that float (composer, menus, switcher): `0 8px 24px rgb(0 0 0 / .18)` in light, a 1 px inner highlight plus a darker shadow in dark.
- Hairlines only where tone can't separate (the header bottom edge, table rows).

### Icons and motion

- One stroke icon set: Lucide, 16 px, 1.75 stroke (thin enough to stay quiet, thick enough to stay crisp at 14–16 px). `ui/src/icons.tsx` re-exports the icons the app uses under its own names.
- Motion is functional: 120–160 ms ease-out for hover and expand, a rotating arc for running, a soft shimmer on the live status text. All of it off under `prefers-reduced-motion`.

## 4. Agents and status

**Agent mark.** Every agent has a 22 px mark with a two-letter monogram from its name. Orchestrators (chats) are filled in their own hue (from the chat's name, since they all share one folder) with `--id-on` letters. Experts are tinted in their repo's identity hue with letters in the same hue, so every expert in `restaurant` looks alike; an expert without a known folder is sunken with a hairline. The selected sidebar row is an `--accent-soft` wash.

**Status on the mark.** A 8 px dot on the mark's bottom-right corner, with a ring in the background colour so it reads on any surface. Status never relies on colour alone: each one also has a shape or a word.

| State | Mark | Sidebar second line |
|---|---|---|
| Running | A small blue arc spinning in the corner instead of the dot | `Running Bash · 1m 12s` |
| Waiting on experts (orchestrator, derived from experts working on a message that reports back to it) | Hollow blue dot | `Waiting on 2 experts` |
| Queued | Amber dot | `2 queued` |
| Finished, unread | Green dot, name in 600 weight | `Replied 2 min ago` |
| Failed | Coral dot | `Failed · Command exited 1` |
| Interrupted | Hollow amber dot | `Interrupted` |
| Idle, seen | No dot | `Idle · 4 min ago` |
| Stopped | Hollow grey dot, name dimmed | `Stopped` |

| Plan waiting for you (orchestrator) | Amber dot, row in Needs you | `Plan ready · round 1, 4 tracks` |
| Questions waiting for you (orchestrator) | Amber dot, row in Needs you | `3 questions for you` |

Orchestrator rows add a roll-up of their experts on the second line when collapsed (`2 running · 1 failed`), so trouble shows with the tree closed.

**Folder on every expert row.** The first line of an expert row is its name followed by the last part of its folder in mono `--text-3` (`web-checkout  shop-web`). The name truncates first; the folder always stays visible. The full path is in the tooltip and in the header's repo chip. Orchestrator rows leave it out, since they all run in `orchestratorFolder`.

## 5. Transcript

The transcript column is centred, 760 px max, with prose at 15 px. Item by item:

- **Messages into the agent** (from you, the orchestrator, or the manager when it is a real prompt) sit in a `--fill` block with a 12 px radius and no border. A speaker line above it: mark, name and time (`You · 11:20`, `[TS] test2 asked · 11:18`). Long ones fold after 8 lines.
- **Agent prose** has no container. Markdown with real typographic care: 1.65 line height, headings at 15/17 px 600, tables with hairline rows and no outer border, inline code on `--fill` in Plex Mono, code blocks on `--sunken` with a language label and a copy button.
- **Work log.** Consecutive tool calls between two pieces of prose collapse into one line: `⌄ Worked for 18s · ran 3 commands, read 2 files`. Expanded, it is a vertical list of steps on a thin timeline, each with an icon, a human label and the duration:
  - Bash shows its `description` (`Count tracked files`), with the command one click deeper.
  - Read, Grep, Glob and Edit show the file name or pattern (`Read auth.ts`, `Searched "token" · 12 hits`).
  - Edit and Write open a real diff with line numbers and +/- counts.
  - A running step shows a live timer; an error step is coral and opens by default.
  - Verbose mode (Ctrl+O) expands all work logs and shows inputs and outputs.
- **Delegations.** `create_expert` and `message_expert` render as one object on `--raised`: the expert's mark, `Asked restaurant-summary` with its repo (the repo name in its identity hue), the first line of the message, and a live status line below (`Working · 32s · Running Bash: Run the e2e tests`, `Replied after 1m 52s`, `Failed: <error>`), with an **Open** button. Consecutive delegations stack with an 8 px gap. When the matching manager notification and `get_expert_output` arrive, they fold into the same object (`Replied · reply read`), instead of showing as three separate items. This is the signature element of the app. Matching is client side: a notification or read goes to the latest delegation to that expert; the reply is the expert's first reply after the message was sent. Only the latest delegation to an expert follows its live state; older ones show how they ended.
- **Manager notifications** that don't match a delegation are a single quiet event line with an icon: `restaurant-summary finished its turn · 11:21`.
- **Turn footer.** After each turn, a mono line in `--text-3`: `✓ Done in 42s · 3 tools · $0.004`, the check in `--done`. Interrupted turns say `Interrupted by you`; failed turns put the error text there in coral. Footers come from the record's last replies (each has `durationMs` and `costUsd`), tied to turns by time: a reply belongs to the last turn that started before it. Older turns, beyond the last 20 replies, have no footer. Claude Code's own `[Request interrupted by user]` marker is hidden, since the footer says it.
- **Thinking** is a step in the work log (`Thought` and its first line); the full text opens on click.

## 6. Header, composer and overview

**Header (two lines).** Line one: the breadcrumb as the title (`[TS] test2 / [RS] restaurant-summary`; the parent part is a link and `Alt+←` goes there), then on the right the repo as a mono chip (`restaurant`, full path on hover, click copies), cost, a context ring with the percentage (amber from 70 %, coral from 85 %), and the `⋯` menu. Line two: the status as a sentence (`Running Bash · 1m 12s`, `Idle · replied 4 min ago`).

**Composer.** A floating `--raised` surface with a 14 px radius and a shadow, two lines tall by default and growing to 40 % of the height.
- Footer row inside it: hints on the left (`Enter to send · Shift+Enter for a new line`), buttons on the right: a round inverted send button (↑), and while running a stop button (■) next to it; the send button then reads as **Queue**.
- While running, a status line sits just above the composer: a rotating arc, `Running Bash: Count tracked files · 12s` with a soft shimmer, and `Esc to interrupt` on the right.
- Queued messages stack directly above the composer as a compact list (`Queued · 2`), one line each, with the sender, the text and a remove button on hover. Later: drag to reorder and "send now".

**Overview (no agent selected).**
- A summary row of four numbers that act as filters: Running, Needs you, Queued, Spend today.
- One section per orchestrator: its name, status and last activity, then its experts as a compact table (mark, name, repo, status sentence, last reply preview, time).
- A "Recent replies" list across all agents on the right (on wide screens).

## 7. Model and effort

**Seeing it.** The header has a chip before the repo chip: `Sonnet 5.5 ▂▄▆ medium ⌄`. Five bars of rising height, filled up to the level (low = 1 … max = 5), show the effort at a glance; the word says it (`default` when none is set). The bars stay neutral: colour is for state. A model without effort levels shows only its name. On narrow screens the chip shows only the model name, and the repo chip only its icon. Delegations, the round tracker and the track plan show the same `model · effort` in mono, with the values the expert actually runs on (inherited ones included). A switch shows in the transcript as an event line, `Model switched to Haiku 5.5`, where the next turn starts (Claude Code writes it into the session as command output).

**Switching it.** Clicking the chip opens a popover:
- **Model**: the aliases from `supportedModels()` (Default, Opus, Sonnet, Fable, Haiku), each with its description from the SDK as the hint, the current one checked on a `--sunken` row. Dated model ids fold under **Other versions**. Picking applies at once.
- **Effort**: a segmented control with only the levels the chosen model supports (`supportedEffortLevels`), so impossible combinations can't be picked. Switching to a model that can't run the current effort drops it back to the default.
- A note: changes apply from the next turn. While a turn runs, the note says which model the running turn finishes on.

**Backend.** Both change mid-session without a restart: `q.setModel(model)` and `q.applyFlagSettings({ effortLevel })` on the live query, applied just before the next message is delivered, so a running turn finishes as it started. The record keeps `model` and `effort` (null = default), so a resumed process (after `idleMinutes` or a restart) gets them as `query()` options, and `activeModel` / `activeEffort` with what the process reports (init message and main-loop assistant messages; effort only when Claude Code reports it). `POST /api/agents/:id/model` takes `{ model?, effort? }`; `GET /api/models` returns the cached `supportedModels()` list.

**Experts inherit.** `model` and `effort` on `create_expert` (and on a track) are optional, and about 90 % of the time they should be left out: an expert then runs on its track's values, else on its orchestrator's current model and effort (copied when the expert is created). There is deliberately no separate expert default in the config. The orchestrator prompt says to set them only when a track clearly needs something else, such as Haiku for a log scan or Opus for a hard design question.

## 8. Track plans

The core flow: you give the orchestrator a problem or a story. It uses what the central repo knows to form first ideas, then proposes **tracks** for a round: an expert in repo A to research one thing, another in repo B in parallel, an expert in the central folder to go through production logs, maybe a subagent of its own. Today that is a text list you answer in prose. A track plan makes it an object you can approve, trim, or answer in the chat.

**How the orchestrator proposes.** A new orchestrator tool, `propose_tracks`:

```ts
propose_tracks({
  round: 1,
  title: 'Find why users bounce back to the cart',
  tracks: [{
    id: 't1',
    title: "Diff session and cart-token handling in Tuesday's release",
    target: { kind: 'new_expert', folder: 'C:/…/foundation', name: 'foundation-sessions' }
          | { kind: 'existing_expert', expertId: 'web-checkout-…' }
          | { kind: 'subagent' },   // runs inside the orchestrator
    summary: 'Looks for changes to token lifetime, cookie flags …',  // for the user, one or two sentences
    model: 'claude-sonnet-5-5', effort: 'high',   // optional
  }],
  later: [   // optional: how the orchestrator expects the next rounds to go, for information only
    { round: 2, title: 'Fix the token check', tracks: [{ title: 'Fix the token check', summary: '…' }, …] },
  ],
})
```

The summary is only for you to decide on. The expert's real instructions are the handoff prompt the orchestrator writes after you say go, so there is nothing to edit in the plan itself. The tool stores the plan in state and returns at once; the orchestrator's prompt tells it to end the turn and wait. The orchestrator gets **Needs you · Plan ready**. Calling `propose_tracks` again for the same round makes a new version (`v2`) that replaces the previous one.

**What you see** (canvas: *Track plan waiting for approval*). In the transcript, after the orchestrator's short reasoning, the plan is one object on `--raised` with a soft shadow, because it is the decision point:
- Header: a `Round 1 · v2` tag, the title, and `Waiting for you` in amber.
- One row per track, read-only apart from its checkbox: the number, the title, one mono line with the target, folder, model and effort (`New expert · foundation · Sonnet 5.5 · high`, `web-checkout (existing) · shop-web · …`, `Subagent of checkout-dropoff`), and the summary. In a new version, tracks that changed say `changed in v2`. Unchecked tracks are dimmed and struck through.
- **Later rounds**, when the orchestrator outlines them, are one folded row below the tracks on a `--sunken` band: `Then · 2 later rounds`, the round titles in one truncated line, and `for information`. Expanded, it lists each later round with its track titles and summaries, without checkboxes: they can't be started from here. When round 1 is done, the orchestrator proposes round 2 as a real plan, which may differ from the outline.
- Footer: `3 of 4 tracks, in parallel. Start sends only the checked tracks.` and one button, **Start 3 tracks**.

**Everything else goes through the normal composer.** There is no separate feedback field: you answer the orchestrator's questions, add context or ask for a different split in the chat, and it answers with a new version of the plan. Placeholder: "Answer, add context, or ask for a different plan".

**Old versions fold away.** When v2 arrives, v1 collapses to one line in the transcript (`Round 1 · v1 · Find why users bounce back to the cart · 4 tracks · Replaced by v2`), which opens on click. Only the current version takes space.

**Start and the chat never mix**, so the orchestrator never gets two contradicting instructions:
- **Start** sends one message with only the checkbox state: the track ids to start and the ones you skipped. It never takes text from the composer.
- **Enter** in the composer sends only what you typed, never the checkboxes. "Only start track 1, and tell it Safari is the priority" is a normal chat message, and the orchestrator acts on it. The composer hint says so: "Enter sends just your message, never the checkboxes."
- There is no keyboard shortcut for Start, so a mistyped key can't fire it.

Either way, the orchestrator writes the handoff prompts and calls `create_expert` / `message_expert` as today, passing the `track_id`, so the manager can tie each expert to its track. Subagent tracks it runs itself. The tracker shows the tracks that were **actually started** (from those `track_id`s), not the checkbox state, so it is right whichever way you started them. A plan started from the chat (no Start) shows its other tracks as `Not started`. Once a round is started, `propose_tracks` for that round is refused; the next round gets the next number.

**After Start** (canvas: *Track plan after Start*). The same object becomes the round's tracker, filling in as the orchestrator starts each track: a thin progress bar with one segment per track, and one row per track with the expert's mark, name, folder, model, live status and the first line of its reply. Skipped tracks stay as one muted line. By default the orchestrator gets **one combined notification when every track of the round has replied**, which fits "collect, then plan round 2"; a toggle switches to a notification per reply. The manager holds the track replies back and releases them once every started track has replied and either every chosen track was started or the orchestrator is idle (so a track it decided not to start doesn't block the round). Round 2 appears as a new plan further down.

**Backend needs.** The `propose_tracks` tool and a `plans` list in state (per orchestrator: rounds, versions, tracks, status), an optional `track_id` on `create_expert` and `message_expert`, `POST /api/plans/:id/start` (only the checked and skipped track ids, delivered as a normal message to the orchestrator), a `plan` SSE event, and round-level notification grouping in `manager.ts`. The `orchestrate` skill (`.claude/skills/orchestrate/SKILL.md`) describes when to propose tracks, that it must wait after proposing, and that it should propose a new version when the user asks for changes.

## 9. Questions

While researching, experts hit questions they can't settle on their own. They report them to the orchestrator together with what they found, each marked as one of two kinds:
- **Cross-repo**: needs information from another repository.
- **Human**: needs a decision, and answering it alone would mean making an assumption.

The orchestrator answers what it already knows or can deduce from the central repo, sends cross-repo questions to an expert in the right repo, and asks you the rest. You answer those with clicks in one place instead of writing "for 1 I'd do this, for 2 that" in the chat.

**How the orchestrator asks.** A new orchestrator tool, `ask_user`:

```ts
ask_user({
  title: 'Questions from round 1',
  questions: [{                    // for the user
    id: 'q2', from: 'foundation-sessions-…',   // the expert who raised it, if any
    question: 'Which SameSite value should the cart cookie get?',
    context: 'Lax fixes Safari but … The October security review asked for Strict.',
    kind: 'single' | 'multi' | 'text',
    options: [{ label: 'Lax for the cart cookie only', detail: 'Fixes the redirect …', suggested: true }, …],
  }],
  resolved: [{ question: '…', answer: '…', source: 'notes/releases' }],      // answered by the orchestrator
  routed:   [{ question: '…', expertId: 'api-contracts-…' }],                // sent to another repo
})
```

Like `propose_tracks`, it stores the set and returns at once, and the orchestrator ends its turn. The orchestrator shows **Needs you · 3 questions for you**. For `routed` questions it also calls `message_expert` with the `question_id`; the expert's reply to that message becomes the question's answer.

**What you see** (canvas: *Questions for you*). A question set is one object on `--raised`, with every question visible in one list:
- Header: the title, `1 of 3 answered` and a segmented progress bar, one segment per question for you.
- **For you**, in order. The expert who raised a question is shown above it with its mark (`foundation-sessions asks · decision`). Then the question in 15 px 600, one or two lines of context, and the answer controls:
  - `single`: full-width option rows (label and one-line detail), a radio, and the key number (`1`–`4`). The orchestrator's suggestion is marked `suggested`, not pre-selected, so a quick Send never answers for you.
  - `multi`: compact toggle chips that wrap.
  - Every question ends with a "Something else…" field for a free answer; `text` questions have only that field.
  - An answered question folds to one line: a filled check, the question in `--text-2` and the answer below it, with **Change**.
- **Answered by the orchestrator** and **Sent to another repo**: two folded groups on a `--sunken` band below, so you can see every question without them competing with yours. Each answered one shows the answer and where it came from (`from notes/releases`, `you said so at 10:29`) with **Correct**, which opens it as a question for you. A routed question shows the expert, its repo and live status, then its answer when it replies.
- Footer: `2 of 3 ready. Unanswered questions stay open here.`, the keyboard hint (`1`–`4` picks, `Tab` next question), and **Send 2 answers**.

**Sending.** The same rule as Start: **Send** delivers only the answers, as one structured message (question id, answer, and any corrections of the orchestrator's answers). Enter in the composer sends only what you typed, never the selected answers. You can send part of the answers; the rest stay open in the set, and the sidebar keeps showing the count. Unsent picks are kept per browser tab, so switching agents doesn't lose them. **Change** reopens an answered question; sending it again marks the answer as changed for the orchestrator. Once every question is answered, the set folds to one line (`Questions from round 1 · 3 by you, 2 by checkout-dropoff, 1 by api-contracts`) that opens on click. The orchestrator passes the answers on to the experts that asked.

**Backend and prompts.** The `ask_user` tool and a `questions` list in state (per orchestrator: sets, questions, answers, status), `POST /api/questions/:id/answer`, a `questions` SSE event, and matching a routed question to the expert's reply. `prompts/expert.md` asks experts to end their findings with their open questions, each marked `cross-repo` or `human`, with what they would assume. The `orchestrate` skill (`.claude/skills/orchestrate/SKILL.md`) describes the triage: answer what it can (and say where from), route cross-repo questions, ask the user the rest with options when there are clear choices, and suggest one when it has a preference.

## 10. Accessibility and quality bar

- Text contrast ≥ 4.5:1 in both themes, including `--text-3`. Status always has a word or shape besides its colour.
- Every interactive thing is a real `<button>` or `<a>`; tree navigation with arrow keys; visible focus ring.
- Check light, dark, and 375 px width for every change (as `CLAUDE.md` already says).
- `prefers-reduced-motion` turns off the arc rotation and shimmer (the arc becomes a static ring).

## 11. Implementation plan

Each step is shippable on its own and gets its own commit. Check every step in the browser against a test manager, in light, dark and a narrow width, and compare it with the canvas. Mark a step done here when it lands.

Status: steps 1–8 done, plus a colour pass after step 8 (aqua accent for actions, repo hues on expert marks, wider dark surface steps).

1. **Foundations.** *(done)* New tokens in `styles.css` (both themes), Plex fonts, Lucide icons, button / input / menu restyle. Drop the activity bar.
2. **Sidebar and header.** *(done)* Agent marks with status, two-line rows with the folder name, Needs you group, footer counts, search field (opens a basic switcher), the two-line header with repo chip and context ring.
3. **Composer.** *(done)* Floating composer, live status line, queue list.
4. **Transcript.** *(done)* Message blocks with speaker lines, prose typography, work-log grouping (`timeline.ts` groups consecutive tool items), turn footers, event lines.
5. **Delegations.** *(done)* The delegation object, folding notifications and `get_expert_output` into it (client-side, matched by expert id and order).
6. **Model and effort.** *(done)* The header chip and popover, the endpoint, `model` / `effort` on `create_expert`, experts inheriting their orchestrator's.
7. **Track plans.** *(done)* `propose_tracks`, plan state and endpoints, the plan object and its tracker, round notifications, the orchestrator prompt.
8. **Questions.** *(done)* `ask_user`, question state and endpoint, the question set, routing cross-repo questions, the expert and orchestrator prompts.
9. **Overview.** The no-selection home.

Backend needs: none for steps 1–5. Turn footers need per-turn duration and cost on each reply in `replies` (the cost is already computed per turn in `AgentRuntime`; duration is `result.duration_ms`). Steps 6 to 8 need the backend work described in their sections. "Spend today" in the overview needs cost per day, which can wait.
