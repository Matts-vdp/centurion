# Files: a tree, a viewer and changes per agent

**Status:** done (steps 1–7). The UI data module is `ui/src/fileStore.ts`, not `files.ts`, because `Files.tsx` exists and Windows file names are case-insensitive.

A read-only view of an agent's folder: browse its files, read one with highlighting, and see what changed in git. It answers "what did this expert actually touch?" without leaving the manager. Staging, committing and merging are in `docs/git-plan.md` (the Changes segment edits no files, but its git actions write); editing files is later.

## 1. Where it lives

**A Files panel on the right of each agent pane**, not a sidebar view. Files belong to an agent's folder, and with split view two folders can be open at once, so a single sidebar view would have to guess which one it shows. (This replaces the "segmented control at the top of the sidebar" idea in `ui-design.md` §2 and `ui-research.md`.)

- **Opening it:** the header's folder chip (`restaurant`) toggles the panel; copying the path moves into the `⋯` menu. `Ctrl+B` toggles it in the focused pane.
- **Panel:** 300 px by default, resizable with a divider like the split one (double-click resets), on `--sunken` like the sidebar so it recedes from the transcript. Open/closed and width are per pane, in `localStorage` with the layout.
- **Viewing a file** widens the panel: tree on the left (narrowed to 220 px), the file on the right, together taking up to 60 % of the pane. `Esc` or the back button returns to the tree only.
- **Narrow panes** (< 620 px, or the narrow screen layout): the panel becomes a sheet over the transcript, with a back button, one level at a time (tree, then file).

## 2. The panel

- **Top:** a segmented control `Files | Changes · 4`, then a filter field (`Filter files…`, `Ctrl+P` while the panel has focus).
- **Files:** a lazy tree of the agent's `cwd`. Folders first, then files, case-insensitively sorted. Folders load when opened; expanded folders are remembered per folder path. Monochrome lucide icons (folder, file, image, markdown); no per-language colours (colour only means state, action or identity).
  - Git ignored entries (`node_modules`, `dist`) are listed last and dimmed to `--text-3`, and never expanded automatically. `.git` is hidden.
  - A changed file shows its git letter on the right in mono: `M`, `A`, `D`, `R`, `U` for untracked and `C` for a conflict (as VS Code does), in `--text-2`. A folder holding changes shows a count (`3`) in `--text-3`. No dots, since dots are state.
  - A file the agent edited **in its current turn** gets the running blue letter while the turn runs, so you can watch an expert work.
- **Filter:** fuzzy match on the relative path over the whole tracked and untracked file list (`git ls-files`, or a capped walk outside git), the best 50 results as flat rows with the folder in `--text-3`. Enter opens the first.
- **Changes:** the branch (`feature/checkout · 2 ahead`), then the changed files as flat rows: letter, path, `+12 −3`. A click opens the diff. Empty: `No changes against HEAD.` Not a git repo: `Not a git repository` and the tab is hidden.

## 3. The viewer

- **Header line:** the path relative to the agent's folder as a breadcrumb (each part opens that folder in the tree), the size and line count in `--text-3`, and buttons: copy path, and for Markdown `Preview | Source`.
- **Text:** line numbers in `--text-3`, highlighting with the `highlight.js` themes the transcript already uses, the mono font at the transcript's code size. Long lines scroll, they don't wrap (a toggle can come later). Files over 1 MB or 20 000 lines: the first part and `Showing the first 1 MB`.
- **Markdown** opens in Preview (the transcript's renderer), since handoff prompts and findings are Markdown.
- **Images** (PNG, JPEG, GIF, WebP, SVG as an image) show fitted on a checkerboard-free `--sunken` surface.
- **Binary:** `Binary file · 2.4 MB`, nothing else.
- **Diff** (from Changes or an Edit step): unified, with the same diff component as the transcript's Edit steps, one hunk header per hunk, and `Open file` to switch to the full file.
- **Deleted file:** the diff only.

## 4. Links from the transcript

- Read, Edit and Write steps' file names become links: Read opens the file, Edit and Write open its diff against HEAD (or the file when it isn't changed in git). They open in the panel of the pane the transcript is in.
- Paths in agent prose aren't linked (too many false positives); a later step can linkify backticked paths that exist.
- Files outside the agent's folder (for example an expert's handoff in the orchestrator's folder, which it reaches through `additionalDirectories`) open too: the panel shows them under a second root named after that folder. Only folders in the agent's `cwd` and `additionalDirectories` are allowed.

## 5. Freshness

No file watcher. The panel refetches (debounced to 500 ms) the open folders, the open file and the git status when:
- a tool result for this agent arrives for Edit, MultiEdit, Write, NotebookEdit or Bash (the `message` SSE event the UI already gets),
- the agent's turn ends,
- the panel opens or the window regains focus,
- the user presses the refresh button in the panel's top row.

Changes made outside the manager (an editor, another tool) show on focus or refresh. A watcher can come later if this feels stale.

## 6. API

All under the token check. `path` is relative to the root, with `/` separators.

| Method | Path | What |
|---|---|---|
| GET | `/api/agents/:id/files/roots` | `{ roots: { name, path }[], git: boolean }`: the agent's `cwd` first, then its `additionalDirectories` |
| GET | `/api/agents/:id/files/list?root=0&path=src` | One folder: `{ entries: { name, type: 'dir' \| 'file' \| 'link', size, mtime, ignored, git? }[] }` |
| GET | `/api/agents/:id/files/all?root=0` | Every tracked and untracked file path (capped at 50 000), for the filter |
| GET | `/api/agents/:id/files/read?root=0&path=…` | `{ kind: 'text', text, truncated, size }`, `{ kind: 'binary', size }`, or the raw image with its content type (`?raw=1`) |
| GET | `/api/agents/:id/git/status?root=0` | `{ branch, ahead, behind, files: { path, status, added, removed }[] }` |
| GET | `/api/agents/:id/git/diff?root=0&path=…` | Unified diff against `HEAD` (an untracked file as all added) |

Backend notes (`src/files.ts`, new):
- **Confinement:** resolve `root + path`, `realpath` it, and require it to stay inside the root's `realpath`; reject `..`, absolute paths and links that point outside. Experts can't be used to read the whole disk through the UI.
- **Git** through `git` itself (`execFile`, no shell, a 10 s timeout): `status --porcelain=v2 -z --branch`, `diff --numstat -z HEAD`, `diff HEAD -- <path>`, `ls-files -z --cached --others --exclude-standard`, `check-ignore -z --stdin` per listed folder. No new dependency. No git installed or not a repo: `git: false` and the git fields are left out.
- **Limits:** listings over 5 000 entries return the first 5 000 and `truncated: true`; reads stop at 1 MB; binary is detected by a NUL byte in the first 8 KB.
- Nothing is cached server side except `check-ignore` results per folder for a few seconds.

## 7. Out of scope here

Editing and saving files, staging, commits, branches, merging (the git panel plan); search inside file contents (a later `git grep` endpoint); a file watcher; files in dev containers (they go through the container's filesystem once that plan lands).

## 8. Implementation plan

1. **Backend:** `src/files.ts` (roots, list, all, read, confinement) and the routes; tried with `curl` against a test manager, including `..` and an outside symlink.
2. **Git:** status, numstat, diff, ignore marks.
3. **Panel and tree:** the header chip toggle, the per-pane panel with divider, lazy tree, ignored and git marks, the filter.
4. **Viewer:** text with line numbers and highlighting, Markdown preview, images, binary and large files.
5. **Changes tab** and diffs, reusing the transcript's diff component.
6. **Links and freshness:** transcript step links, refetch on tool results and turn ends, the running mark.
7. **Docs:** README (usage and API table), `ui-design.md` (the panel section, and §2's layout note), `CLAUDE.md` layout and status.

Each step is checked in the browser pane in light, dark and a narrow width, and committed on its own.
