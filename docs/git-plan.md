# Git: changes, commits, sync, branches, log and conflicts

**Status:** steps 1 to 5 (backend reads and writes, the Changes view, the diff viewer, remote and sync) done; the rest planned. Builds on the Files panel (`docs/files-plan.md`), which already shows git status and a unified diff against `HEAD`.

The goal: the git work you do around an agent's changes, without leaving the manager. You read the diff, stage what you want, type a message, then commit and push. You sync with the remote, switch or create a branch, and merge `master` in with your open changes put aside and restored on their own. When that conflicts, you resolve it in the same panel. Rider and VS Code are the model (research summary in §11); where they differ, this plan picks what fits a manager of agents.

## 1. Decisions

- **The index is the truth.** Staged and unstaged changes are two groups, as in VS Code, and they map one to one to git's index. What an agent ran `git add` on shows up as staged. There are no changelists and no shelf.
- **Pull merges by default**, configurable (`gitPull: 'merge' | 'rebase'` in the config, default `merge`). Sync passes `--no-rebase` or `--rebase` explicitly, so the repo's own `pull.rebase` doesn't change what the button does.
- **No force push, anywhere.** A rejected push offers Sync. Actions that would only be pushable with force are disabled and say why: Amend and Rebase when the commits are already pushed.
- **Never lose work.** Local changes are put aside with git's own `--autostash` (or stash, switch, pop) and restored afterwards. A stash that can't be restored cleanly is kept. No `reset --hard`, no `clean`, no `checkout --force`. The only actions that destroy work are Discard and deleting a branch. Both ask first.
- **Agents don't block git.** You can use git while an agent of that repo is running; you decide when to wait. The manager does serialise its *own* git writes per repository, so two panes on one repo can't race. When git itself is busy (`index.lock`), the manager retries once after 500 ms and then says so.
- **Agents aren't told.** Commits, switches and merges from the UI send nothing to any agent. The one exception is a button that fills the composer for you (§8, "Ask the agent"); you still send it yourself.
- **Writing is allowed for git actions.** The Files panel still doesn't edit files. Git actions may change the working tree: discard, switch, merge, and saving a conflict resolution.
- **No AI commit messages** for now.

## 2. Where it lives

The Files panel gets a third segment: `Files | Changes · 4 | Log`. It is a panel per pane on the right, opened by the header's repo chip or `Ctrl+B`, as before. Git is per repository and the Files panel already belongs to one agent's folder, so the panel is the right home. The header gets nothing new: it is already full (model, repo, cost, context, cache), and the branch lives at the top of Changes and Log.

The git views work on the repository that holds the agent's folder (root 0). The second root, an expert's orchestrator folder, stays read-only here; a root picker can come later.

**A folder inside a bigger repo.** When the agent's folder is a subfolder of the repository, git actions still apply to the whole repository: a commit takes everything staged. So the Changes view lists the changes outside the folder too, in a folded `Outside this folder · n` group at the bottom. Those rows show only their repo-relative path. You can stage, unstage and discard them, but their diffs don't open, because the panel's confinement stays as it is.

## 3. Changes view

```
┌ Changes ─────────────────────────────┐
│ ⑂ feature/checkout ⌄      ↓1 ↑2 Sync │   branch row
│ ⚠ Merging master · 2 conflicts       │   operation banner (only during one)
│   Abort                    Continue  │
│ Conflicts · 2                        │
│   C  cart.ts           src/cart      │
│ Staged · 2                         − │
│   M  auth.ts           src     +12 −3│
│ Changes · 3                    + ↶ ⋯ │
│   M  token.ts          src      +4 −1│
│   U  token.test.ts     src      +40  │
│ › Outside this folder · 1            │
│──────────────────────────────────────│
│ ┌──────────────────────────────────┐ │
│ │ Message for 2 staged files       │ │   commit box (pinned)
│ └──────────────────────────────────┘ │
│ ☐ Amend                 [Commit | ⌄] │
│ Committed 3f2a1c9 · Undo             │   result line
└──────────────────────────────────────┘
```

- **Branch row** (top): branch icon and name as a button that opens the branch menu (§6), then `↓1 ↑2` in mono `--text-2` (hidden at 0), then one **Sync** button. Without an upstream the button reads **Publish**. Detached HEAD shows `detached at 3f2a1c9` and a **Create branch here** action in the menu.
- **Operation banner**, only while a merge, rebase, cherry-pick, revert or stash restore is in progress (from git's state files, so it also shows when an agent or a terminal started it). It uses `--waiting` text with a warning icon, not a tinted box. The sentence names the branches (`Merging master into feature/checkout · 2 conflicts`, `Rebasing onto origin/main · commit 2 of 5`), with **Abort** and **Continue** on the right. Continue is disabled, with a tooltip, until no conflicts remain. For a merge it opens the commit box with git's prepared message; for a rebase it runs `rebase --continue`.
- **Groups**, in this order: Conflicts, Staged, Changes (tracked and untracked together; untracked files have the `U` letter), Outside this folder. Each group header is `Name · n` in the sidebar's group style, with hover actions on the right:
  - Staged: Unstage all (−).
  - Changes: Stage all (+), Discard all (↶), and a `⋯` menu.
  - Empty groups are hidden. With nothing at all: `No changes. Working tree clean.`
- **Rows** keep today's look: the letter in mono `--text-2`, the file name, its folder in `--text-3`, and `+12 −3`. Conflict letters use `--waiting`, since a conflict waits on you. Hover shows the row's actions on the right: stage (+) or unstage (−), discard (↶), open file. A click opens the diff for that side (§4). Keyboard: ↑/↓ move, Enter opens, Space stages or unstages. Discard has no key, so it can't fire by accident.
- **Discard asks in place**, with the rewind strip pattern (a raised strip under the row): `Discard your changes to token.ts? This can't be undone.` For an untracked file: `Delete token.test.ts? It isn't in git, so this can't be undone.` Discard all states the count. Discard of a tracked file restores the working copy from the index (`restore --worktree`), so staged work survives.
- **Commit box**, pinned to the bottom of the panel so it doesn't move as the lists grow:
  - A text field, two lines by default and growing to eight, with the composer's list continuation. Its placeholder says what will happen: `Message for 2 staged files`, or `Message · commits all 5 changes` when nothing is staged. Committing with nothing staged asks once in place (`Nothing is staged. Commit all 5 changes?`), with an "always" choice remembered per browser.
  - The draft is kept per repository, per browser, so switching agents doesn't lose it.
  - From 50 characters on, the first line shows its length in `--text-3` on the right. No warning colour: it's a convention, not an error.
  - **Amend** checkbox: it fills in the last message and turns the button into **Amend**. It is disabled when HEAD is already pushed (`Already pushed: amending would need a force push`).
  - A split button: **Commit** (primary) and a `⌄` with **Commit and Push** and **Commit and Sync**. `Ctrl+Enter` commits; `Ctrl+Shift+Enter` commits and pushes.
  - Disabled buttons always say why in a tooltip (`Write a message`, `Resolve 2 conflicts first`).
- **Result line** under the commit box, in `--text-3`: what the last action did, in words. Examples: `Committed 3f2a1c9 · Undo`, `Pulled 3 commits from origin/main, pushed 2`, `Switched to main · your changes were put aside and restored`. A **Details** toggle shows the git commands that ran and their output. The line stays until the next action. Errors take the same place in `--failed` (§9).
- **Undo commit** (in the result line and on the top commit in the Log) soft-resets the last commit. The changes stay staged and the message goes back into the box. It is offered only when that commit isn't pushed and isn't a merge commit. Undo instead of a confirmation: a commit is cheap to take back.

## 4. Diff viewer

The panel's viewer, extended. It applies wherever a diff shows: Changes, Log, and the transcript's Edit links.

- **Which diff.** Opened from Changes it is `index ↔ working tree`. From Staged it is `HEAD ↔ index`. From the tree, a transcript link or a file with no staged part, it is `HEAD ↔ working tree`, as today. When a file is partly staged, the viewer bar's `Changes` becomes `Changes | Staged`, so both halves are one click apart.
- **Split and unified.** A `Unified | Split` toggle on the viewer bar, remembered per browser. Split needs room: below 720 px of viewer width it falls back to unified, and the toggle says so in its tooltip. Split is built in the UI from the unified hunks: removed and added runs pair up side by side, with blank filler on the shorter side.
- **Word highlights.** Within a paired removed and added line, the changed words get a stronger tint of the existing diff colours. This is computed in the UI with a small token diff (own code or the `diff` package) and skipped for lines over 500 characters.
- **Whitespace and context.** A `⋯` on the bar holds **Ignore whitespace** (`-w`) and **Show whole file** (`-U` with the file's length). Each hunk header has small up and down arrows that load 20 more lines of context.
- **Moving between changes:** `Alt+↓` / `Alt+↑` jump to the next or previous hunk, and a `2 of 5` in `--text-3` on the bar says where you are.
- **Staging from the diff.** On a working-tree diff, each hunk header has **Stage** and **Discard** (discard asks in place). On a staged diff it has **Unstage**. To stage single lines, click or Shift+click line numbers; the selection gets the accent tint and a small floating bar offers **Stage 3 lines** or **Discard 3 lines**.
  - The manager builds the patch from a fresh diff. It refuses, then refreshes, when the file changed since you looked: the request carries a hash of the diff you saw. That matters, because an agent may be editing the same file.
  - Partial patches follow `git add -p`'s rules: unselected `+` lines are dropped and unselected `−` lines become context. They are applied with `git apply --cached` (stage), `git apply --cached -R` (unstage) or `git apply -R` (discard).
- Binary files: `Binary file changed · 2.4 MB → 2.5 MB`, with stage and unstage on the file only.

## 5. Sync and the remote

- **Fetch** runs when you open Changes or Log and the last fetch was over 5 minutes ago, and from the branch menu. There is no background timer. The ahead/behind tooltip says `Fetched 3 min ago`.
- **Sync**: fetch, then pull if behind (`--no-rebase` or `--rebase` per `gitPull`, always with `--autostash`), then push if ahead. Each step is skipped when there is nothing to do. The result line says what happened. If the pull conflicts, Sync stops there and the operation banner takes over; the push waits until you run Sync again.
- **Push** alone is in the Sync button's menu, along with **Pull** and **Fetch**. A rejected push (`non-fast-forward`) says `The remote has new commits` with **Sync**. There is never a force push.
- **Publish** (no upstream): `push -u <remote> <branch>`. With one remote it uses that one; with several, the menu asks which.
- **Credentials.** Network commands run with `GIT_TERMINAL_PROMPT=0`, so git never waits for a terminal prompt that doesn't exist; Git Credential Manager's own window still works on Windows. A failure says `Git needs credentials for origin. Sign in once from a terminal (git fetch) and try again.` Network commands get a 5 minute timeout instead of 10 s, and a **Cancel** on the busy button.

## 6. Branches

The branch row's name opens a popover in the model popover's style:

- A field at the top, `Switch to or create a branch…`. Typing filters the branches. When nothing matches exactly, the first row is **Create `feature/x` from `feature/checkout`** (Enter); `⋯` on that row picks another start point.
- **Update from `master`**: a prominent first action when the current branch isn't the default branch. It fetches, then merges `origin/master` (the remote's default branch, from `origin/HEAD`) into the current branch with `--autostash`. This is Rider's "merge master in", made one click, and it uses the fresh remote branch rather than a possibly stale local `master`.
- **Local branches**, current first with a check, each with its `↓↑` against its upstream in mono `--text-3`. Then **Remote** as a folded group. The `⋯` of a row (or →) offers:
  - **Switch**. A remote branch creates a tracking local branch.
  - **Merge into `feature/checkout`** (`merge --autostash`).
  - **Rebase `feature/checkout` onto this**, disabled with a reason when the current branch's commits are already pushed.
  - **Compare with current**: opens the Log filtered to `current..branch` and back.
  - **Delete**, local only. It asks in place, and asks again in stronger words when git says the branch isn't merged (`-D`).
- **Switching with local changes.** When git refuses a switch because of local changes, the manager stashes them, switches and pops the stash, then reports it in the result line. If the pop conflicts, the stash is kept, the conflicts show, and the banner says `Restoring your changes conflicted · they are kept in the stash` with **Resolve**.
- **Autostash and conflicts.** With `merge --autostash`, git restores the stash when the merge ends, by Continue or by Abort. So a conflicted merge never strands your changes. The plan relies on that, and the banner mentions `your changes come back when the merge ends`.

## 7. Log

The third segment of the panel.

- **Scope** toggle at the top: `This branch | All branches`. A filter field below it matches subject, author and hash. The first 200 commits load, and **Load more** at the end fetches more.
- **Rows** (26 px): the graph, then refs and the subject, then the author's short name and relative time in mono `--text-3` on the right.
  - Refs sit before the subject as quiet mono `--text-2` text with an icon: branch, tag, or cloud for remote. Only rows that have refs show them; no pills.
  - Commits not yet pushed get a small `↑` and incoming ones (on the upstream, not local) a `↓`, both in `--text-3`, so "what will Sync do" is visible without a list behind the chip.
- **Graph**: lanes drawn in SVG from the parent hashes, hairline `--text-3`, the current branch's first-parent line in `--text-2`. Commits are 7 px dots; HEAD is a hollow ring. No lane colours, since colour is for state, action and identity.
- **Commit details** open in the viewer:
  - The subject (15 px, 600) and the body as preformatted text.
  - A mono meta line: hash (copy), author, date, and parents as links.
  - The changed files as Changes rows. Clicking one opens its diff against the first parent; merge commits say `against first parent`.
- **Commit actions** (`⋯` on a row and in the details): **Copy hash**, **New branch from here**, **Undo commit** (top commit only, under the conditions in §3). Revert and cherry-pick come later.

## 8. Conflicts

**Names, not sides.** Everywhere, the two sides are named after what they are: `feature/checkout (yours)` and `master (incoming)`. For a rebase, that's the commit being replayed and the branch you rebase onto. Never "ours" and "theirs", which swap meaning during a rebase.

**8a. The list and inline resolution** (first step):
- The Conflicts group lists the files. Each row's `⋯` offers **Take yours**, **Take incoming** and **Open**.
- For delete/modify conflicts the choices are **Keep the file** and **Delete it**. Binary files get only the two takes.
- **Resolve all simple ones** in the group header: the files where every block is whitespace-only, or where one side equals the base. It says how many it resolved and leaves the rest.
- **Opening a conflicted file** shows it in the viewer with each conflict as a block: `Conflict 1 of 3`, then the two sides one under the other, each under its name, with the base on a toggle. Actions per block: **Take yours**, **Take incoming**, **Both, yours first**, **Both, incoming first**, **Edit**. Edit turns that block into a plain mono text field. A resolved block collapses to the chosen text with **Change**.
- The bar counts what's left (`1 of 3 left`). **Mark resolved** writes the file and stages it; it's available once no blocks are left.
- The three versions come from the index stages (`:1:`, `:2:`, `:3:`), not from parsing the markers, so `conflictStyle` doesn't matter. The non-conflicting parts are already merged by git.
- **Ask the agent** in the banner and the group header fills the pane's composer (it doesn't send) with a short message: the operation, the branches and the conflicted files. You edit it and send it yourself, or don't.

**8b. Three-pane resolver** (later step):
- Yours on the left, the result in the middle, incoming on the right, scrolling together.
- Every change from either side is shown, the non-conflicting ones already applied (with **Ignore** to undo one).
- A conflict gets `»` / `«` buttons in the gutter to take a side into the result, both in either order.
- The result is editable per block, as in 8a. A **Base** toggle adds the common ancestor.
- It needs room, so it takes the whole pane (Esc returns to the panel). Below 900 px of pane width it opens as 8a instead.

## 9. Errors and feedback

- Every action shows its progress on its own button (`Pushing…`, with Cancel for network commands). The rest of the panel stays usable, but other git writes on the same repository wait their turn.
- Errors take the result line's place in `--failed`: a plain sentence first, then **Details** with git's stderr. Known cases get their own sentence:
  - Credentials, and a rejected push.
  - `index.lock`: `Git is busy in this repository: another git command is running`.
  - Merge refused because untracked files would be overwritten (it names them).
  - Missing `user.name` / `user.email`.
  - A failing commit hook. Hooks run; `--no-verify` isn't offered.
- After every write, the panel refetches status, the open diff and the Log, and the server sends a `git` SSE event per repository, so another pane on the same repo refreshes too. The existing refresh triggers stay: tool results, turn end, focus, the refresh button.

## 10. API

All under the token check. Each takes `root` (only 0 for writes) and resolves the repository from it. Writes return the new status. Paths are repo-relative for git routes, except the working-tree diff's `path`, which is relative to the root like the file routes (it only opens inside the folder); the status's `prefix` converts between the two.

| Method | Path | What |
|---|---|---|
| GET | `/api/agents/:id/git/status` | Extended: `{ branch, detached, head, upstream, ahead, behind, fetchedAt, operation: null \| { kind, onto, step, total }, conflicts, staged, unstaged, outside, files }` (`files` stays for the tree marks) |
| GET | `/api/agents/:id/git/diff?path=&side=worktree\|staged\|head&context=&whitespace=` | A diff for one side, plus its hash |
| POST | `/api/agents/:id/git/stage`, `.../unstage`, `.../discard` | `{ paths }` |
| POST | `/api/agents/:id/git/apply` | `{ path, side, hunks, lines, hash, action: 'stage' \| 'unstage' \| 'discard' }` |
| POST | `/api/agents/:id/git/commit` | `{ message, amend, all }` → `{ hash }` |
| POST | `/api/agents/:id/git/undo-commit` | Soft reset of an unpushed, non-merge HEAD |
| POST | `/api/agents/:id/git/fetch`, `.../pull`, `.../push`, `.../sync`, `.../publish` | `{ remote? }` |
| GET | `/api/agents/:id/git/branches` | `{ current, default, local: [...], remote: [...] }` with ahead/behind |
| POST | `/api/agents/:id/git/branch` | Create: `{ name, from, switch }`; delete: `{ name, delete: true, force? }` |
| POST | `/api/agents/:id/git/switch` | `{ branch }` (with stash, switch, pop when needed) |
| POST | `/api/agents/:id/git/merge`, `.../rebase` | `{ branch }` / `{ onto }`, with `--autostash` |
| POST | `/api/agents/:id/git/abort`, `.../continue` | The operation in progress |
| GET | `/api/agents/:id/git/log?scope=&skip=&filter=&range=` | `{ commits: { hash, parents, subject, author, date, refs, pushed }[] }` |
| GET | `/api/agents/:id/git/commit/:hash` | Message, meta and changed files; `?path=` for one file's diff |
| GET | `/api/agents/:id/git/conflict?path=` | `{ base, yours, incoming, labels, blocks }` |
| POST | `/api/agents/:id/git/resolve` | `{ path, content }` or `{ path, take: 'yours' \| 'incoming' \| 'delete' }`, then stages it |

As built in step 1 (the route table in `src/server.ts` has the exact shapes; `centurion api` prints them):
- Status adds `prefix` (the root's path in the repository, `''` or ending in `/`). `outside` is `{ conflicts, staged, unstaged }`, the same groups as the root's. Group entries are `{ path, status, added, removed, oldPath?, code? }`, `code` being a conflict's two letters (`UU`, `DU`, …) for the delete/modify choices. `operation` also has `branch` (the branch a rebase is rebasing, as HEAD is detached meanwhile) and a kind `am`. Untracked files outside the folder get no line counts (they aren't read).
- Diff: `context` is a number of lines, `whitespace=ignore` gives `-w`. `hash` is the sha1 of the whole diff before truncation. A staged rename diffs against its old path.
- Log: commits also have `email` and `incoming` (on the upstream, not in HEAD), the result has `more`. `scope=branch` logs HEAD and its upstream, so incoming commits show; `pushed` means reachable from any remote-tracking branch. `filter` searches the newest 50 000 commits.
- Commit details: `files` entries have `inside`; `?path=` is refused (403) for a file outside the agent's folder, like the working-tree diffs.
- Branches add `remotes` (the remote names, for Publish). The `main` / `master` fallback for `default` counts a branch that exists locally or on origin, else `default` is null. `local` lists the current branch first; each has `upstream`, `ahead`, `behind` and `gone`.

As built in step 2 (`src/gitwrite.ts`):
- Write routes take `?root=` (only `0`, the default). They return `{ status, commands }` plus their own fields (`deleted`, `whole`, `hash`, `undone` and `message`); `commands` are `[{ command, code, output }]` for Details. Errors are `{ error, details, commands }`: the sentence, git's output, the commands that ran. Git refusals are 409, bad requests 400.
- Stage is `add -A` on the paths (so deletions too); a conflicted path may be staged (marked resolved) once it has no conflict markers. Unstage is `reset -q -- paths` (works without commits) and takes a staged rename's old path along; conflicts are refused. Discard needs unstaged changes on every path and refuses conflicts. Paths go to git through `--pathspec-from-file` with `--literal-pathspecs`.
- Apply: `path` is relative to the root (like the diff route, so the hash matches), `lines` are indexes into `diff.split('
')`, `hunks` hunk indexes, and `context` must match the diff that was shown (`-U0` applies with `--unidiff-zero`). Stage and discard take `side: 'worktree'`, unstage `side: 'staged'`. When unstaging or discarding the patch applies with `-R`, so the `add -p` rules swap (an unselected `+` becomes context, an unselected `-` is dropped). Selecting every change does the whole-file action. Renamed, binary and truncated files, and deletions when unstaging or discarding, are whole-file only. Part of an untracked file is staged as a new file with only those lines.
- Commit refuses with conflicts or nothing staged (a merge in progress may commit without changes). A failing hook is named when one of `pre-commit`, `prepare-commit-msg`, `commit-msg` exists. Undo also refuses the first commit and while a merge or rebase is in progress, and takes an optional `hash` that must still be HEAD.
- The `git` SSE event is `{ repo, agentIds }`: the repository's top and the agents with a root in it. It follows every write that ran a git command, also a failed one (a failed commit may have staged everything first).

As built in step 3 (`ui/src/Changes.tsx`, wired in `ui/src/Files.tsx`):
- Status adds `headPushed` (HEAD is on a remote-tracking branch), which disables Amend with its reason. Amend fills in the last message from the commit route and puts the draft aside; unticking brings the draft back.
- The branch line is a plain line for now (name, `↓n ↑n`, detached at a hash); the branch row with Sync comes in step 5. The split button's `⌄` already lists **Commit and Push** and **Commit and Sync**, disabled with `Comes with sync`; `Ctrl+Shift+Enter` waits for step 5 too.
- Staging and unstaging leave the result line alone (the lists show them) unless they fail, so a commit's **Undo** survives staging the next files. Discard, commit, amend and undo write it. Undo isn't offered after an amend, since it would take back the whole commit.
- A row opens the side of its group when the file is partly staged (`staged` or `worktree`), else `HEAD ↔ working tree` as before; the viewer bar says `Staged` / `Not staged`. Conflict rows open the file; their `+` marks them resolved (refused while markers remain). Rows outside the folder show the repo path and don't open.
- The Changes group's `⋯` has **Stage tracked files only** and **Discard tracked changes only…**. The tab count is every changed path in the repository, outside the folder included, since a commit takes those too.
- The draft is `centurion-commit-draft:<repo top>` and "always commit all" is `centurion-commit-all`, both in `localStorage`.

As built in step 4 (`ui/src/DiffView.tsx`, `ui/src/diffModel.ts`, wired in the viewer in `ui/src/Files.tsx`):
- A partly staged file never shows the combined HEAD diff: opening it from the tree or a link shows its unstaged half, and the bar reads `File | Changes | Staged`. A HEAD diff of a file that is only unstaged (or untracked) stages and discards like a working-tree diff, and one that is only staged unstages: its hunks are the same, so the hash matches. When staging from the diff makes a file partly staged, the viewer moves to the side it staged from; when a file stops being partly staged, back to HEAD.
- More context is added in the UI rather than by asking git: the hunk header's ↑ shows 20 lines above the hunk, ↓ 20 lines below the previous one, and a row after the last hunk shows the rest of the file (left out when the last hunk already reaches the end). The lines come from the new route `GET .../git/side-text` (the diff's new side: the working tree, or the index for `staged`), so the diff and the line indexes staging sends stay as git made them. **Show whole file** does ask git, with `-U1000000`, and staging then sends that `context`.
- **Ignore whitespace** is per panel and turns staging from the diff off (the buttons' tooltip says so): the apply route rebuilds the diff without `-w`, so the hash wouldn't match, and a `-w` patch may not apply. Truncated diffs stage only as a whole file.
- Word highlights pair the n-th removed line of a run with its n-th added line and compare their tokens (words, spaces, symbols) with a longest common subsequence; pairs that share under 40 % stay a plain change. Split view wraps long lines.
- Hunk and line discards write the panel's result line (`Discarded a change in app.ts`). Errors, the stale-hash 409 among them, show on a line above the diff, and a 409 also refreshes it. Esc clears a line selection before it closes the file.
- The diff route's binary result has `sizes: { old, new }` (bytes, null for a missing side).

As built in step 5 (`src/gitwrite.ts`, `ui/src/Changes.tsx`):
- The five remote routes return `{ status, commands, pulled, pushed, conflicted }`; Cancel returns `{ cancelled }` and stops the current network command for the repository without removing queued writes. Fetch uses the tracking remote, or all remotes if the branch has no upstream. Explicit Pull runs even when already up to date; Sync skips Pull and Push when their counts are zero. A conflicting Pull returns its status and leaves Push for another Sync.
- `gitPull` is a documented config field, default `merge`. Both modes pass `--autostash`. Push uses git's normal fast-forward safety. A rejected push maps to `The remote has new commits`.
- The branch row shows Publish or Sync, ahead and behind counts and a fetch-age tooltip. Its menu offers Push, Pull and Fetch; Publish asks which remote when there is more than one. Changes fetches once on opening when the last fetch is older than five minutes. The commit split button now offers Commit and Push / Sync and `Ctrl+Shift+Enter` commits and pushes. Without an upstream, either combined action publishes; with several remotes it asks which one before committing. The remote result and its commands use the existing result line.

Backend notes (`src/git.ts`, new; the read helpers move there from `src/files.ts`, and the confinement helpers they share to `src/confine.ts`):
- Git runs as `git` itself, as today: no shell, `core.quotepath=off`, `GIT_OPTIONAL_LOCKS=0` for reads only (writes need the locks).
- A per-repository promise queue for writes, keyed by `git rev-parse --show-toplevel`.
- Timeouts: 10 s for local commands, 5 min for network commands and for commit (hooks).
- Operation state comes from `.git/MERGE_HEAD`, `rebase-merge/`, `rebase-apply/`, `CHERRY_PICK_HEAD` and `REVERT_HEAD` (through `git rev-parse --git-path`, so worktrees work).
- The default branch comes from `refs/remotes/origin/HEAD`, falling back to `main`, then `master`.
- Routes go in the route table with summaries, and `gitPull` goes in the config schema, so `npm run check:docs` covers them.

## 11. Research summary

- **Rider** (JetBrains):
  - Commit tool window with chunk and line checkboxes, Amend, message history, and Commit and Push.
  - Update Project: fetch, then merge or rebase, with "clean working tree using stash/shelve".
  - Smart Checkout and Smart merge: stash, act, restore.
  - Branch popup: new, checkout, merge into current, rebase, compare, diff with working tree.
  - Conflict dialog (accept yours or theirs per file, resolve simple ones) and a three-pane merge tool with an editable result, per-chunk arrows, "apply non-conflicting" and magic resolve.
  - Force push only with lease.
- **VS Code**:
  - Staged and Changes groups mapped to the index.
  - Staging of hunks and selected ranges from the diff.
  - A commit button with Commit and Push / Commit and Sync / Amend.
  - A Sync button with counts, and Publish Branch.
  - A graph with incoming and outgoing commits.
  - Inline conflict actions: current, incoming, both, compare.
  - A 3-way merge editor (Incoming, Current, Result, base view, conflict count, Complete Merge stages the file), timeline, blame and worktrees.
- Taken from Rider: smart switch and merge, the three-pane resolver, merging master in as one action. Taken from VS Code: the index model, the commit and Sync buttons, Publish, inline conflict blocks, incoming and outgoing marks in the Log. Left out: changelists, the shelf, force push, AI messages.

## 12. Out of scope here

Stash list and stash UI; cherry-pick, revert commit, interactive rebase; blame and file history; tags; git on the second root; worktrees for experts (separate branches for parallel tracks, a plan of its own); editing files outside conflict resolution; a background fetch timer; GitHub pull requests.

## 13. Implementation plan

Each step is shippable on its own and gets its own commit. Test against a test manager with scratch repositories and a local bare repository as `origin` (no network, no agents needed for most steps). Check every UI step in light, dark and a narrow width.

1. **Backend reads:** `src/git.ts`, extended status (staged, unstaged, conflicts, operation, upstream, outside), diff sides and options, log, commit details, branches.
2. **Backend writes:** the per-repo queue, error mapping, the `git` SSE event; stage, unstage, discard, partial apply with the diff hash, commit, amend, undo commit.
3. **Changes view:** groups, row actions, discard in place, commit box with draft, split button, result line and Details. CLAUDE.md's "Files are read-only" rule becomes "the panel edits no files; git actions may write".
4. **Diff viewer:** sides, `Changes | Staged`, split view, word highlights, whitespace and context, next and previous change, hunk and line staging.
5. **Remote:** branch row, fetch on open, Sync, Push, Pull, Publish, credentials handling, Cancel, `gitPull` in the config.
6. **Branches:** the popover, create, switch with stash, Update from `master`, merge and rebase with autostash, compare, delete; the operation banner with Abort and Continue.
7. **Log:** the segment, rows with refs and ↑↓ marks, the graph, commit details and diffs, row actions.
8. **Conflicts, inline (8a):** the group, takes per file, simple ones, conflict blocks in the viewer, Mark resolved, Ask the agent.
9. **Three-pane resolver (8b).**
10. **Docs:** `ui-design.md` §6a (Files and git), `CLAUDE.md` layout and status, `README.md` if usage changes.
