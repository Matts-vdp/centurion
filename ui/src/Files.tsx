import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { AgentRecord, LiveMessage } from './api';
import {
  baseName,
  dirName,
  editedPath,
  EDIT_TOOLS,
  expanded as expandedStore,
  filesApi,
  filterPaths,
  formatSize,
  joinPath,
  locate,
  panels,
  usePanel,
  type DiffSide,
  type Entry,
  type FileContent,
  type FileDiff,
  type GitFile,
  type GitLetter,
  type GitStatus,
  type OpenRequest,
  type Root,
} from './fileStore';
import { BackIcon, CheckIcon, Chevron, CloseIcon, CopyIcon, FileCodeIcon, FileIcon, FileImageIcon, FolderIcon, FolderOpenIcon, RefreshIcon } from './icons';
import { changeCount, Changes, type ResultLine } from './Changes';
import { store } from './store';
import { highlight, languageOf } from './highlight';
import { Markdown } from './Transcript';

/** `line`: scroll to that line and mark it (a link from a visual). `side`: which diff (HEAD ↔ working tree when unset). */
type View = { root: number; path: string; mode: 'file' | 'diff'; line?: number; side?: DiffSide };
type Dir = { entries: Entry[]; truncated: boolean } | { error: string };

const COMPACT_BELOW = 620;
const MIN_WIDTH = 220;
/** What the transcript keeps at least, beside the panel. */
const MIN_REST = 320;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i;
const CODE_EXT = /\.(tsx?|jsx?|mjs|cjs|py|rs|go|java|kt|cs|c|h|cpp|hpp|rb|php|swift|sh|ps1|sql|css|scss|html?|vue|svelte|json|ya?ml|toml|xml)$/i;
const MARKDOWN_EXT = /\.(md|markdown|mdx)$/i;

type Props = {
  agent: AgentRecord;
  pane: number;
  /** A file to open, from a transcript link. */
  request: OpenRequest | null;
  onRequestDone: () => void;
};

/** The Files panel beside an agent's transcript: its folders as a tree, a file viewer and git changes. */
export function FilesPanel({ agent, pane, request, onRequestDone }: Props) {
  const state = usePanel(pane);
  const ref = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(false);
  const [roots, setRoots] = useState<Root[] | null>(null);
  const [rootsError, setRootsError] = useState('');
  const [tab, setTab] = useState<'files' | 'changes'>('files');
  const [dirs, setDirs] = useState<Map<string, Dir>>(new Map());
  const [open, setOpen] = useState<Set<string>[]>([]);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [version, setVersion] = useState(0);
  const [filter, setFilter] = useState('');
  const [allFiles, setAllFiles] = useState<string[][] | null>(null);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [missing, setMissing] = useState('');
  /** What the last git action did, under the commit box; it stays while you switch between Files and Changes. */
  const [gitResult, setGitResult] = useState<ResultLine | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const dirsRef = useRef(dirs);
  dirsRef.current = dirs;
  const openRef = useRef(open);
  openRef.current = open;
  const rootsRef = useRef(roots);
  rootsRef.current = roots;

  // Narrow panes: the panel covers the transcript instead of sitting beside it.
  useLayoutEffect(() => {
    const host = ref.current?.parentElement;
    if (!host) return;
    const observer = new ResizeObserver(() => setCompact(host.clientWidth < COMPACT_BELOW));
    observer.observe(host);
    setCompact(host.clientWidth < COMPACT_BELOW);
    return () => observer.disconnect();
  }, []);

  const loadDir = useCallback(
    async (root: number, path: string) => {
      const key = `${root}:${path}`;
      try {
        const listing = await filesApi.list(agent.id, root, path);
        setDirs((d) => new Map(d).set(key, listing));
      } catch (err) {
        setDirs((d) => new Map(d).set(key, { error: err instanceof Error ? err.message : String(err) }));
      }
    },
    [agent.id],
  );

  const loadStatus = useCallback(async () => {
    const r = rootsRef.current;
    if (!r?.[0]?.git) return setStatus(null);
    try {
      setStatus((await filesApi.status(agent.id, 0)).status);
    } catch {
      setStatus(null);
    }
  }, [agent.id]);

  // Roots, then the top folders and the folders left open last time.
  useEffect(() => {
    let cancelled = false;
    filesApi
      .roots(agent.id)
      .then(({ roots }) => {
        if (cancelled) return;
        setRoots(roots);
        rootsRef.current = roots;
        const sets = roots.map((r, i) => {
          const s = expandedStore.read(r.path);
          // The agent's own folder starts open; the others folded.
          if (i === 0) s.add('');
          return s;
        });
        setOpen(sets);
        sets.forEach((s, i) => s.forEach((p) => void loadDir(i, p)));
        void loadStatus();
      })
      .catch((err) => !cancelled && setRootsError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [agent.id, loadDir, loadStatus]);

  /** Reload what is on screen: open folders, the git status and the open file. */
  const refresh = useCallback(() => {
    const r = rootsRef.current;
    if (!r) return;
    openRef.current.forEach((s, i) => s.forEach((p) => dirsRef.current.has(`${i}:${p}`) && void loadDir(i, p)));
    void loadStatus();
    setAllFiles(null);
    setVersion((v) => v + 1);
  }, [loadDir, loadStatus]);

  const timer = useRef<number | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      refresh();
    }, 500);
  }, [refresh]);
  useEffect(() => () => void (timer.current !== null && window.clearTimeout(timer.current)), []);

  // The agent's own edits: refresh after each tool result of an editing tool or Bash, and at the turn's end.
  useEffect(() => {
    let pending = false;
    return store.onLive((e) => {
      if (e.agentId !== agent.id || e.kind !== 'message') return;
      const m = e.message as LiveMessage;
      if (m.type === 'assistant') {
        for (const block of contentOf(m)) {
          if (block.type !== 'tool_use' || typeof block.name !== 'string') continue;
          if (EDIT_TOOLS.has(block.name) || block.name === 'Bash') pending = true;
          const p = editedPath(block.name, (block.input ?? {}) as Record<string, unknown>);
          if (p) setTouched((t) => new Set(t).add(normAbs(p)));
        }
      } else if (m.type === 'user' && pending) {
        pending = false;
        scheduleRefresh();
      } else if (m.type === 'result') {
        pending = false;
        setTouched(new Set());
        scheduleRefresh();
      }
    });
  }, [agent.id, scheduleRefresh]);

  // Git writes in this agent's repository, from this pane or any other.
  useEffect(() => store.onGit((e) => e.agentIds.includes(agent.id) && scheduleRefresh()), [agent.id, scheduleRefresh]);
  useEffect(() => setGitResult(null), [agent.id]);

  // Changes made elsewhere (an editor) show when you come back to the window.
  useEffect(() => {
    const onFocus = () => scheduleRefresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [scheduleRefresh]);

  const setFolder = useCallback(
    (root: number, path: string, isOpen: boolean) => {
      setOpen((sets) => {
        const next = [...sets];
        const s = new Set(next[root] ?? []);
        if (isOpen) s.add(path);
        else s.delete(path);
        next[root] = s;
        const r = rootsRef.current?.[root];
        if (r) expandedStore.write(r.path, s);
        return next;
      });
      if (isOpen && !dirsRef.current.has(`${root}:${path}`)) void loadDir(root, path);
    },
    [loadDir],
  );

  /** Open every folder above a path, so its row shows in the tree. */
  const reveal = useCallback(
    (root: number, path: string) => {
      const parts = path.split('/');
      setFolder(root, '', true);
      for (let i = 1; i < parts.length; i++) setFolder(root, parts.slice(0, i).join('/'), true);
    },
    [setFolder],
  );

  const changed = useMemo(() => new Map((status?.files ?? []).map((f) => [f.path, f])), [status]);

  const openFile = useCallback(
    (root: number, path: string, mode: 'file' | 'diff' = 'file', line?: number, side?: DiffSide) => {
      setMissing('');
      setView({ root, path, mode, line, ...(side && side !== 'head' ? { side } : {}) });
      reveal(root, path);
    },
    [reveal],
  );

  // A transcript link: find the file's root, then show its diff if git has changes for it.
  useEffect(() => {
    if (!request || !roots) return;
    onRequestDone();
    const at = locate(roots, request.path);
    if (!at) {
      setView(null);
      setMissing(`${request.path} is outside ${agent.name}’s folders.`);
      return;
    }
    setTab('files');
    const hasDiff = at.root === 0 && changed.has(at.path);
    openFile(at.root, at.path, request.mode === 'diff' && hasDiff && !request.line ? 'diff' : 'file', request.line);
  }, [request, roots, changed, openFile, onRequestDone, agent.name]);

  // Ctrl+P in the panel goes to the filter; Esc closes the file, then leaves the panel alone.
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      setTab('files');
      setView(compact ? null : view);
      window.setTimeout(() => filterRef.current?.focus());
    } else if (e.key === 'Escape') {
      if (filter) setFilter('');
      else if (view) setView(null);
      else return;
      e.preventDefault();
    }
  };

  // Load every file name for the filter the first time it's used (and after a refresh).
  useEffect(() => {
    if (!filter.trim() || allFiles || !roots) return;
    let cancelled = false;
    Promise.all(roots.map((_, i) => filesApi.all(agent.id, i).then((r) => r.files).catch(() => [] as string[]))).then(
      (lists) => !cancelled && setAllFiles(lists),
    );
    return () => {
      cancelled = true;
    };
  }, [filter, allFiles, roots, agent.id]);

  const viewing = view !== null || missing !== '';
  const width = viewing ? (state.viewWidth !== null ? `${state.viewWidth}px` : '60%') : `${state.width}px`;
  const running = agent.status === 'running';
  const showTree = !(compact && viewing);

  return (
    <aside
      ref={ref}
      className={`files-panel${compact ? ' compact' : ''}${viewing ? ' viewing' : ''}`}
      style={compact ? undefined : { width }}
      aria-label={`Files of ${agent.name}`}
      onKeyDown={onKeyDown}
    >
      {!compact && <PanelDivider pane={pane} viewing={viewing} />}
      {showTree && (
        <div className="files-side">
          <div className="files-top">
            {roots?.[0]?.git ? (
              <div className="segmented files-tabs" role="tablist" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <button role="tab" aria-selected={tab === 'files'} className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>
                  Files
                </button>
                <button role="tab" aria-selected={tab === 'changes'} className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>
                  Changes{changeCount(status) > 0 ? ` · ${changeCount(status)}` : ''}
                </button>
              </div>
            ) : (
              <span className="files-title">Files</span>
            )}
            <button className="icon-button" title="Refresh" aria-label="Refresh the files" onClick={refresh}>
              <RefreshIcon size={15} />
            </button>
            <button className="icon-button" title="Close the files (Ctrl+B)" aria-label="Close the files" onClick={() => panels.set(pane, { open: false })}>
              <CloseIcon size={15} />
            </button>
          </div>
          {rootsError ? (
            <p className="files-note">{rootsError}</p>
          ) : !roots ? (
            <p className="files-note">Loading…</p>
          ) : tab === 'files' ? (
            <>
              <div className="files-filter">
                <input
                  ref={filterRef}
                  type="search"
                  placeholder="Filter files…"
                  aria-label="Filter files by name"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const first = filterResults(allFiles, roots, filter)[0];
                      if (first) openFile(first.root, first.path);
                    }
                  }}
                />
              </div>
              {filter.trim() ? (
                <FilterResults results={filterResults(allFiles, roots, filter)} loading={!allFiles} roots={roots} view={view} onOpen={openFile} />
              ) : (
                <Tree
                  roots={roots}
                  dirs={dirs}
                  open={open}
                  view={view}
                  touched={running ? touched : null}
                  onToggle={setFolder}
                  onOpen={openFile}
                />
              )}
            </>
          ) : (
            <Changes
              agentId={agent.id}
              rootPath={roots[0].path}
              status={status}
              selected={view && view.root === 0 ? { path: view.path, side: view.mode === 'diff' ? (view.side ?? 'head') : 'head' } : null}
              result={gitResult}
              onResult={setGitResult}
              onWritten={(next, deleted) => {
                setStatus(next);
                if (deleted && view?.root === 0 && deleted.includes(view.path)) setView(null);
                scheduleRefresh();
              }}
              onOpen={(p, mode, side) => openFile(0, p, mode, undefined, side)}
            />
          )}
        </div>
      )}
      {viewing && (
        <div className="files-view">
          {missing ? (
            <div className="viewer">
              <div className="viewer-head">
                <button className="icon-button" title="Back (Esc)" aria-label="Back to the files" onClick={() => setMissing('')}>
                  <BackIcon size={15} />
                </button>
              </div>
              <p className="files-note">{missing}</p>
            </div>
          ) : (
            view &&
            roots && (
              <Viewer
                key={`${view.root}:${view.path}:${view.line ?? ''}:${view.side ?? ''}`}
                agentId={agent.id}
                root={roots[view.root]}
                view={view}
                version={version}
                change={view.root === 0 ? changed.get(view.path) : undefined}
                onMode={(mode) => setView({ ...view, mode })}
                onClose={() => setView(null)}
                onFolder={(dir) => {
                  setTab('files');
                  setFilter('');
                  reveal(view.root, joinPath(dir, 'x'));
                  if (compact) setView(null);
                }}
              />
            )
          )}
        </div>
      )}
    </aside>
  );
}

function contentOf(m: LiveMessage): { type?: string; name?: unknown; input?: unknown }[] {
  const content = (m.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? content : [];
}

function normAbs(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-zA-Z]:/.test(s) ? s.toLowerCase() : s;
}

function filterResults(all: string[][] | null, roots: Root[], query: string): { root: number; path: string }[] {
  if (!all) return [];
  const flat: string[] = [];
  const owner: number[] = [];
  all.forEach((list, i) =>
    list.forEach((p) => {
      flat.push(i === 0 ? p : `${roots[i].name}/${p}`);
      owner.push(i);
    }),
  );
  const index = new Map(flat.map((p, i) => [p, i]));
  return filterPaths(flat, query).map((p) => {
    const i = owner[index.get(p)!];
    return { root: i, path: i === 0 ? p : p.slice(roots[i].name.length + 1) };
  });
}

// ---------- resizing ----------

function PanelDivider({ pane, viewing }: { pane: number; viewing: boolean }) {
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const panel = e.currentTarget.parentElement!;
    const host = panel.parentElement!;
    const rect = host.getBoundingClientRect();
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const w = Math.round(Math.min(rect.width - MIN_REST, Math.max(MIN_WIDTH, rect.right - ev.clientX)));
      panels.set(pane, viewing ? { viewWidth: w } : { width: w });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
    };
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div
      className="files-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the files panel"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => panels.set(pane, viewing ? { viewWidth: null } : { width: 300 })}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const panel = e.currentTarget.parentElement!;
        const w = Math.max(MIN_WIDTH, panel.getBoundingClientRect().width + (e.key === 'ArrowLeft' ? 24 : -24));
        panels.set(pane, viewing ? { viewWidth: w } : { width: w });
      }}
    />
  );
}

// ---------- tree ----------

type Row =
  | { kind: 'root'; root: number; name: string; open: boolean }
  | { kind: 'entry'; root: number; path: string; entry: Entry; depth: number; open: boolean }
  | { kind: 'note'; depth: number; text: string; error?: boolean };

function Tree({
  roots,
  dirs,
  open,
  view,
  touched,
  onToggle,
  onOpen,
}: {
  roots: Root[];
  dirs: Map<string, Dir>;
  open: Set<string>[];
  view: View | null;
  touched: Set<string> | null;
  onToggle: (root: number, path: string, open: boolean) => void;
  onOpen: (root: number, path: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const rows: Row[] = [];
  const visit = (root: number, path: string, depth: number) => {
    const dir = dirs.get(`${root}:${path}`);
    if (!dir) return void rows.push({ kind: 'note', depth, text: 'Loading…' });
    if ('error' in dir) return void rows.push({ kind: 'note', depth, text: dir.error, error: true });
    if (dir.entries.length === 0 && depth > 0) rows.push({ kind: 'note', depth, text: 'Empty' });
    for (const entry of dir.entries) {
      const p = joinPath(path, entry.name);
      const isOpen = entry.type === 'dir' && (open[root]?.has(p) ?? false);
      rows.push({ kind: 'entry', root, path: p, entry, depth, open: isOpen });
      if (isOpen) visit(root, p, depth + 1);
    }
    if (dir.truncated) rows.push({ kind: 'note', depth, text: 'Only the first 5 000 entries are shown' });
  };
  roots.forEach((r, i) => {
    const isOpen = open[i]?.has('') ?? false;
    if (roots.length > 1) rows.push({ kind: 'root', root: i, name: r.name, open: isOpen });
    if (isOpen) visit(i, '', roots.length > 1 ? 1 : 0);
  });

  // The open file's row scrolls into view.
  const selectedKey = view ? `${view.root}:${view.path}` : '';
  useEffect(() => {
    if (!selectedKey) return;
    ref.current?.querySelector<HTMLElement>('.file-row.selected')?.scrollIntoView({ block: 'nearest' });
  }, [selectedKey, rows.length]);

  /** Arrow keys move between rows; → opens a folder, ← closes it. */
  const onKey = (e: ReactKeyboardEvent, row: Row) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('.file-row') ?? [])];
    const at = buttons.indexOf(e.currentTarget as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      buttons[Math.min(buttons.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const folder = row.kind === 'root' ? { root: row.root, path: '' } : row.kind === 'entry' && row.entry.type === 'dir' ? row : null;
      if (!folder) return;
      e.preventDefault();
      onToggle(folder.root, folder.path, e.key === 'ArrowRight');
    }
  };

  return (
    <div className="file-tree" ref={ref} role="tree" aria-label="Files">
      {rows.map((row, n) => {
        if (row.kind === 'note') {
          return (
            <div key={`note-${n}`} className={`file-note${row.error ? ' error' : ''}`} style={{ paddingLeft: indent(row.depth) + 22 }}>
              {row.text}
            </div>
          );
        }
        if (row.kind === 'root') {
          return (
            <button
              key={`root-${row.root}`}
              className="file-row root"
              role="treeitem"
              aria-expanded={row.open}
              title={roots[row.root].path}
              onClick={() => onToggle(row.root, '', !row.open)}
              onKeyDown={(e) => onKey(e, row)}
            >
              <Chevron open={row.open} size={14} />
              <span className="file-name">{row.name}</span>
              {row.root > 0 && <span className="file-hint">shared folder</span>}
            </button>
          );
        }
        const { entry } = row;
        const isDir = entry.type === 'dir';
        const selected = view?.root === row.root && view.path === row.path;
        const abs = normAbs(`${roots[row.root].path}/${row.path}`);
        const isTouched = !isDir && touched?.has(abs);
        const letter: GitLetter | undefined = isTouched ? (entry.git ?? 'M') : entry.git;
        return (
          <button
            key={`${row.root}:${row.path}`}
            className={`file-row${selected ? ' selected' : ''}${entry.ignored ? ' ignored' : ''}${entry.git === 'D' ? ' deleted' : ''}`}
            role="treeitem"
            aria-expanded={isDir ? row.open : undefined}
            aria-selected={selected}
            style={{ paddingLeft: indent(row.depth) }}
            title={row.path}
            onClick={() => (isDir ? onToggle(row.root, row.path, !row.open) : onOpen(row.root, row.path))}
            onKeyDown={(e) => onKey(e, row)}
          >
            {isDir ? <Chevron open={row.open} size={14} /> : <span className="chevron-space" />}
            <EntryIcon name={entry.name} dir={isDir} open={row.open} />
            <span className="file-name">{entry.name}</span>
            {letter && (
              <span className={`git-letter mono${isTouched ? ' touched' : ''}`} title={isTouched ? 'Edited in this turn' : gitTitle(letter)}>
                {letter}
              </span>
            )}
            {isDir && entry.changes !== undefined && !row.open && (
              <span className="git-count mono" title={`${entry.changes} changed file${entry.changes === 1 ? '' : 's'}`}>
                {entry.changes}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function indent(depth: number): number {
  return 8 + depth * 14;
}

function EntryIcon({ name, dir, open }: { name: string; dir: boolean; open?: boolean }) {
  if (dir) return open ? <FolderOpenIcon size={15} /> : <FolderIcon size={15} />;
  if (IMAGE_EXT.test(name)) return <FileImageIcon size={15} />;
  if (CODE_EXT.test(name)) return <FileCodeIcon size={15} />;
  return <FileIcon size={15} />;
}

function gitTitle(letter: GitLetter): string {
  return { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', U: 'Untracked', C: 'Conflict' }[letter];
}

function FilterResults({
  results,
  loading,
  roots,
  view,
  onOpen,
}: {
  results: { root: number; path: string }[];
  loading: boolean;
  roots: Root[];
  view: View | null;
  onOpen: (root: number, path: string) => void;
}) {
  if (loading) return <p className="files-note">Loading the file list…</p>;
  if (results.length === 0) return <p className="files-note">No file matches.</p>;
  return (
    <div className="file-tree" role="listbox" aria-label="Matching files">
      {results.map((r) => {
        const selected = view?.root === r.root && view.path === r.path;
        const dir = dirName(r.path);
        return (
          <button key={`${r.root}:${r.path}`} className={`file-row flat${selected ? ' selected' : ''}`} role="option" aria-selected={selected} title={r.path} onClick={() => onOpen(r.root, r.path)}>
            <EntryIcon name={r.path} dir={false} />
            <span className="file-name">{baseName(r.path)}</span>
            <span className="file-dir">{r.root > 0 ? `${roots[r.root].name}/${dir}` : dir}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------- viewer ----------

function Viewer({
  agentId,
  root,
  view,
  version,
  change,
  onMode,
  onClose,
  onFolder,
}: {
  agentId: string;
  root: Root;
  view: View;
  version: number;
  change: GitFile | undefined;
  onMode: (mode: 'file' | 'diff') => void;
  onClose: () => void;
  onFolder: (dir: string) => void;
}) {
  const rootIndex = view.root;
  const [content, setContent] = useState<FileContent | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState('');
  // A link to a line shows a Markdown file's source, where the line is.
  const [source, setSource] = useState(view.line !== undefined);
  const [copied, setCopied] = useState(false);
  const deleted = change?.status === 'D';
  const mode = deleted ? 'diff' : view.mode;
  const side = view.side ?? 'head';

  useEffect(() => {
    let cancelled = false;
    setError('');
    const load =
      mode === 'diff'
        ? filesApi.diff(agentId, rootIndex, view.path, side).then((d) => !cancelled && setDiff(d))
        : filesApi.read(agentId, rootIndex, view.path).then((c) => !cancelled && setContent(c));
    load.catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [agentId, rootIndex, view.path, mode, side, version]);

  const parts = view.path.split('/');
  const isMarkdown = MARKDOWN_EXT.test(view.path);
  const absolute = `${root.path.replace(/[\\/]+$/, '')}${root.path.includes('\\') ? '\\' : '/'}${view.path.split('/').join(root.path.includes('\\') ? '\\' : '/')}`;
  const copy = () =>
    void navigator.clipboard?.writeText(absolute).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });

  const meta =
    mode === 'file' && content
      ? content.kind === 'text'
        ? `${content.lines.toLocaleString()} line${content.lines === 1 ? '' : 's'} · ${formatSize(content.size)}`
        : formatSize(content.size)
      : change?.added !== null && change && side === 'head'
        ? `+${change.added} −${change.removed ?? 0}`
        : '';

  return (
    <div className="viewer">
      <div className="viewer-head">
        <button className="icon-button" title="Back to the files (Esc)" aria-label="Back to the files" onClick={onClose}>
          <BackIcon size={15} />
        </button>
        <nav className="viewer-path mono" aria-label="Path" title={absolute}>
          {parts.map((part, i) => {
            const last = i === parts.length - 1;
            return (
              <span key={i} className="viewer-crumb">
                {i > 0 && <span className="viewer-sep">/</span>}
                {last ? <span className="viewer-file">{part}</span> : <button onClick={() => onFolder(parts.slice(0, i + 1).join('/'))}>{part}</button>}
              </span>
            );
          })}
        </nav>
        <button className="icon-button" title={copied ? 'Copied' : 'Copy the full path'} aria-label="Copy the full path" onClick={copy}>
          {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
        </button>
      </div>
      <div className="viewer-bar">
        {change && !deleted && (
          <div className="segmented viewer-toggle" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <button className={mode === 'file' ? 'on' : ''} aria-pressed={mode === 'file'} onClick={() => onMode('file')}>
              File
            </button>
            <button className={mode === 'diff' ? 'on' : ''} aria-pressed={mode === 'diff'} onClick={() => onMode('diff')}>
              Changes
            </button>
          </div>
        )}
        {mode === 'file' && isMarkdown && content?.kind === 'text' && (
          <div className="segmented viewer-toggle" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <button className={!source ? 'on' : ''} aria-pressed={!source} onClick={() => setSource(false)}>
              Preview
            </button>
            <button className={source ? 'on' : ''} aria-pressed={source} onClick={() => setSource(true)}>
              Source
            </button>
          </div>
        )}
        <span className="viewer-meta mono">
          {mode === 'diff' && side !== 'head' && <span>{side === 'staged' ? 'Staged' : 'Not staged'} · </span>}
          {change && <span title={gitTitle(change.status)}>{gitTitle(change.status)} · </span>}
          {meta}
        </span>
      </div>
      <div className="viewer-body">
        {error ? (
          <p className="files-note error">{error}</p>
        ) : mode === 'diff' ? (
          diff ? (
            <UnifiedDiff diff={diff} side={side} />
          ) : (
            <p className="files-note">Loading…</p>
          )
        ) : !content ? (
          <p className="files-note">Loading…</p>
        ) : content.kind === 'image' ? (
          <div className="viewer-image">
            <img src={filesApi.rawUrl(agentId, rootIndex, view.path, version)} alt={baseName(view.path)} />
          </div>
        ) : content.kind === 'binary' ? (
          <p className="files-note">Binary file · {formatSize(content.size)}</p>
        ) : (
          <>
            {content.truncated && <p className="files-note">Showing the first 1 MB of {formatSize(content.size)}.</p>}
            {isMarkdown && !source ? (
              <div className="prose viewer-prose">
                <Markdown text={content.text} />
              </div>
            ) : (
              <Code text={content.text} path={view.path} line={view.line} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Text with line numbers; highlighted when the language is known and the file isn't huge. */
function Code({ text, path, line }: { text: string; path: string; line?: number }) {
  const html = useMemo(() => highlight(text, languageOf(path)), [text, path]);
  const mark = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    mark.current?.scrollIntoView({ block: 'center' });
  }, [line, html]);
  const lines = text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
  const numbers = useMemo(() => Array.from({ length: Math.max(1, lines) }, (_, i) => i + 1).join('\n'), [lines]);
  return (
    <div className="code-view">
      {line !== undefined && line <= lines && <div ref={mark} className="code-line-mark" style={{ top: `calc(10px + ${line - 1} * 1.6em)` }} aria-hidden="true" />}
      <pre className="code-gutter mono" aria-hidden="true">
        {numbers}
      </pre>
      {/* highlight.js escapes the text, so its output is safe to insert. */}
      {html !== null ? <pre className="code-text mono hljs" dangerouslySetInnerHTML={{ __html: html }} /> : <pre className="code-text mono">{text}</pre>}
    </div>
  );
}

/** A git diff's hunks, in the transcript's diff style, with old and new line numbers. */
function UnifiedDiff({ diff, side }: { diff: FileDiff; side: DiffSide }) {
  if (diff.binary) return <p className="files-note">Binary file changed.</p>;
  if (!diff.diff.trim()) return <p className="files-note">{side === 'staged' ? 'Nothing staged in this file.' : side === 'worktree' ? 'No unstaged changes in this file.' : 'No changes against HEAD.'}</p>;
  let oldLine = 0;
  let newLine = 0;
  const rows = diff.diff.split('\n').flatMap((line, n) => {
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      if (m) [oldLine, newLine] = [Number(m[1]), Number(m[2])];
      return [
        <div key={n} className="diff-line hunk">
          <span className="diff-num" />
          <span className="diff-num" />
          <span className="diff-text">{line}</span>
        </div>,
      ];
    }
    if (line.startsWith('\\')) return [];
    if (line === '' && n === diff.diff.split('\n').length - 1) return [];
    const kind = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx';
    const row = (
      <div key={n} className={`diff-line ${kind}`}>
        <span className="diff-num">{kind !== 'add' ? oldLine : ''}</span>
        <span className="diff-num">{kind !== 'del' ? newLine : ''}</span>
        <span className="diff-sign">{kind === 'add' ? '+' : kind === 'del' ? '−' : ' '}</span>
        <span className="diff-text">{line.slice(1) || ' '}</span>
      </div>
    );
    if (kind !== 'add') oldLine++;
    if (kind !== 'del') newLine++;
    return [row];
  });
  return (
    <>
      {diff.truncated && <p className="files-note">The diff is cut off at 1 MB.</p>}
      <div className="diff viewer-diff">{rows}</div>
    </>
  );
}
