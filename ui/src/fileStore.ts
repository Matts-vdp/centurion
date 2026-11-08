import { useSyncExternalStore } from 'react';
import { api, ApiError, token } from './api';

// ---------- API ----------

export type GitLetter = 'M' | 'A' | 'D' | 'R' | 'U' | 'C';
export type Root = { name: string; path: string; git: boolean };
export type Entry = {
  name: string;
  type: 'dir' | 'file' | 'link';
  size: number;
  mtime: number;
  ignored: boolean;
  git?: GitLetter;
  changes?: number;
};
export type GitFile = { path: string; status: GitLetter; added: number | null; removed: number | null; oldPath?: string };
/** One side of a change, path relative to the repository; `code` is a conflict's two letters (`UU`, `DU`, …). */
export type GitEntry = { path: string; status: GitLetter; added: number | null; removed: number | null; oldPath?: string; code?: string };
export type GitGroups = { conflicts: GitEntry[]; staged: GitEntry[]; unstaged: GitEntry[] };
export type GitOperation = { kind: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'am'; onto: string | null; step: number | null; total: number | null; branch: string | null };
export type GitStatus = GitGroups & {
  branch: string | null;
  detached: boolean;
  head: string | null;
  headPushed: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  fetchedAt: number | null;
  operation: GitOperation | null;
  /** The root's path in the repository: `''`, or ending in `/`. */
  prefix: string;
  outside: GitGroups;
  /** The root's changes against HEAD, paths relative to the root (the tree marks). */
  files: GitFile[];
};
export type DiffSide = 'head' | 'staged' | 'worktree';
/** A git command a write ran, with its output, for Details. */
export type GitCommand = { command: string; code: number; output: string };
export type GitWrite = { status: GitStatus | null; commands: GitCommand[] };
export type FileContent =
  | { kind: 'text'; text: string; size: number; truncated: boolean; lines: number }
  | { kind: 'image'; size: number; mediaType: string }
  | { kind: 'binary'; size: number };
/** `hash`: the sha1 of the whole diff, which partial staging sends back. `sizes`: a binary file's sides in bytes. */
export type FileDiff = {
  diff: string;
  status: GitLetter | null;
  binary: boolean;
  truncated: boolean;
  hash: string;
  sizes?: { old: number | null; new: number | null };
};
/** `context`: lines around each change (git's default 3 when unset); `whitespace`: `-w`. */
export type DiffOptions = { context?: number; ignoreWhitespace?: boolean };
export type ApplyAction = 'stage' | 'unstage' | 'discard';

const q = (root: number, path?: string) => `root=${root}${path !== undefined ? `&path=${encodeURIComponent(path)}` : ''}`;

export const filesApi = {
  roots: (id: string) => api<{ roots: Root[] }>(`/api/agents/${id}/files/roots`),
  list: (id: string, root: number, path: string) =>
    api<{ entries: Entry[]; truncated: boolean }>(`/api/agents/${id}/files/list?${q(root, path)}`),
  all: (id: string, root: number) => api<{ files: string[]; truncated: boolean }>(`/api/agents/${id}/files/all?${q(root)}`),
  read: (id: string, root: number, path: string) => api<FileContent>(`/api/agents/${id}/files/read?${q(root, path)}`),
  rawUrl: (id: string, root: number, path: string, version: number) =>
    `/api/agents/${id}/files/read?${q(root, path)}&raw=1&token=${encodeURIComponent(token)}&v=${version}`,
  status: (id: string, root: number) => api<{ status: GitStatus | null }>(`/api/agents/${id}/git/status?${q(root)}`),
  diff: (id: string, root: number, path: string, side: DiffSide = 'head', opts: DiffOptions = {}) =>
    api<FileDiff>(
      `/api/agents/${id}/git/diff?${q(root, path)}${side !== 'head' ? `&side=${side}` : ''}${opts.context !== undefined ? `&context=${opts.context}` : ''}${opts.ignoreWhitespace ? '&whitespace=ignore' : ''}`,
    ),
  /** The new side of a diff as text (working tree, or the index for `staged`), for more context around hunks. */
  sideText: (id: string, root: number, path: string, side: DiffSide) =>
    api<{ text: string | null; truncated?: boolean }>(`/api/agents/${id}/git/side-text?${q(root, path)}&side=${side}`),
};

/** Git writes on the repository of the agent's own folder (root 0). Paths are relative to the repository. */
export const gitApi = {
  stage: (id: string, paths: string[]) => api<GitWrite>(`/api/agents/${id}/git/stage`, { method: 'POST', body: { paths } }),
  unstage: (id: string, paths: string[]) => api<GitWrite>(`/api/agents/${id}/git/unstage`, { method: 'POST', body: { paths } }),
  discard: (id: string, paths: string[]) => api<GitWrite & { deleted: string[] }>(`/api/agents/${id}/git/discard`, { method: 'POST', body: { paths } }),
  commit: (id: string, req: { message: string; amend: boolean; all: boolean }) =>
    api<GitWrite & { hash: string }>(`/api/agents/${id}/git/commit`, { method: 'POST', body: req }),
  undoCommit: (id: string, hash: string) =>
    api<GitWrite & { undone: string; message: string }>(`/api/agents/${id}/git/undo-commit`, { method: 'POST', body: { hash } }),
  /** Part of one file's diff; `path` relative to the root, `lines` indexes into `diff.split('
')`. */
  apply: (id: string, req: { path: string; side: 'worktree' | 'staged'; hunks: number[]; lines: number[]; hash: string; action: ApplyAction; context?: number }) =>
    api<GitWrite & { whole: boolean }>(`/api/agents/${id}/git/apply`, { method: 'POST', body: req }),
  commitInfo: (id: string, hash: string) => api<{ hash: string; subject: string; body: string }>(`/api/agents/${id}/git/commit/${hash}?root=0`),
};

/** A failed git write as the panel shows it: the sentence, git's output and the commands that ran. */
export type GitFailure = { error: string; details: string; commands: GitCommand[] };

export function gitFailure(err: unknown): GitFailure {
  if (err instanceof ApiError) {
    const commands = Array.isArray(err.data.commands) ? (err.data.commands as GitCommand[]) : [];
    return { error: err.message, details: typeof err.data.details === 'string' ? err.data.details : '', commands };
  }
  return { error: err instanceof Error ? err.message : String(err), details: '', commands: [] };
}

// ---------- paths ----------

/** Forward slashes, no trailing slash; lower case on Windows-style paths, for comparing. */
function norm(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-zA-Z]:/.test(s) ? s.toLowerCase() : s;
}

/** Which root an absolute path is in, and its path relative to that root. */
export function locate(roots: Root[], absolute: string): { root: number; path: string } | null {
  const target = norm(absolute);
  const original = absolute.replace(/\\/g, '/');
  // The longest root wins (an expert's folder may sit inside its orchestrator's).
  let best: { root: number; path: string } | null = null;
  let bestLength = -1;
  for (let i = 0; i < roots.length; i++) {
    const base = norm(roots[i].path);
    if ((target === base || target.startsWith(base + '/')) && base.length > bestLength) {
      best = { root: i, path: original.slice(base.length + 1) };
      bestLength = base.length;
    }
  }
  return best;
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function baseName(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

export function dirName(p: string): string {
  const at = p.lastIndexOf('/');
  return at < 0 ? '' : p.slice(0, at);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Fuzzy filter for the file list: substring in the name first, then in the path, then letters in order. */
export function filterPaths(paths: string[], query: string, limit = 50): string[] {
  const needle = query.trim().toLowerCase().replace(/\\/g, '/');
  if (!needle) return [];
  const scored: { p: string; score: number }[] = [];
  for (const p of paths) {
    const lower = p.toLowerCase();
    const name = lower.slice(lower.lastIndexOf('/') + 1);
    let score: number;
    if (name.startsWith(needle)) score = 0;
    else if (name.includes(needle)) score = 1;
    else if (lower.includes(needle)) score = 2;
    else if (subsequence(lower, needle)) score = 3;
    else continue;
    scored.push({ p, score: score * 1000 + Math.min(p.length, 999) });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => s.p);
}

function subsequence(hay: string, needle: string): boolean {
  let i = 0;
  for (const ch of hay) if (ch === needle[i] && ++i === needle.length) return true;
  return false;
}

// ---------- per-browser panel state ----------

/** Per pane (0 = left, 1 = right): whether the Files panel is open, and its widths. */
export type PanelState = {
  open: boolean;
  /** Width of the tree alone, in px. */
  width: number;
  /** Width while a file is shown, in px; null means 60 % of the pane. */
  viewWidth: number | null;
};

const PANEL_KEY = 'centurion-files-panel';
export const PANEL_DEFAULT: PanelState = { open: false, width: 300, viewWidth: null };

function readPanels(): PanelState[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PANEL_KEY) ?? '[]') as Partial<PanelState>[];
    return [0, 1].map((i) => ({
      open: raw[i]?.open === true,
      width: typeof raw[i]?.width === 'number' ? raw[i]!.width! : PANEL_DEFAULT.width,
      viewWidth: typeof raw[i]?.viewWidth === 'number' ? raw[i]!.viewWidth! : null,
    }));
  } catch {
    return [{ ...PANEL_DEFAULT }, { ...PANEL_DEFAULT }];
  }
}

class PanelStore {
  private value = readPanels();
  private readonly listeners = new Set<() => void>();
  get = () => this.value;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  set(pane: number, patch: Partial<PanelState>): void {
    const next = [...this.value];
    next[pane] = { ...next[pane], ...patch };
    this.value = next;
    try {
      localStorage.setItem(PANEL_KEY, JSON.stringify(next));
    } catch {
      // storage blocked: not remembered
    }
    for (const fn of this.listeners) fn();
  }
  toggle(pane: number): void {
    this.set(pane, { open: !this.value[pane].open });
  }
}

export const panels = new PanelStore();

export function usePanel(pane: number): PanelState {
  return useSyncExternalStore(panels.subscribe, () => panels.get()[pane] ?? PANEL_DEFAULT);
}

/** Expanded folders per root folder, so a tree opens the way you left it. */
export const expanded = {
  key: (rootPath: string) => `centurion-files-open:${norm(rootPath)}`,
  read(rootPath: string): Set<string> {
    try {
      const raw = JSON.parse(localStorage.getItem(this.key(rootPath)) ?? '[]');
      return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
    } catch {
      return new Set();
    }
  },
  write(rootPath: string, open: Set<string>): void {
    try {
      localStorage.setItem(this.key(rootPath), JSON.stringify([...open].slice(0, 500)));
    } catch {
      // storage blocked
    }
  },
};

// ---------- commit drafts ----------

/** The repository's top folder, from the root's folder and its path in the repository (`prefix`). */
export function repoTop(rootPath: string, prefix: string): string {
  const root = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const up = prefix.split('/').filter(Boolean).length;
  return up === 0 ? root : root.split('/').slice(0, -up).join('/');
}

/** Small per-browser values; storage may be blocked, then nothing is remembered. */
function readValue(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeValue(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage blocked
  }
}

/** The commit message being written, per repository, so switching agents doesn't lose it. */
export const commitDrafts = {
  key: (top: string) => `centurion-commit-draft:${norm(top)}`,
  read(top: string): string {
    return readValue(this.key(top)) ?? '';
  },
  write(top: string, text: string): void {
    writeValue(this.key(top), text ? text : null);
  },
};

/** Unified or split diffs, per browser. */
export const diffLayout = {
  get: (): 'unified' | 'split' => (readValue('centurion-diff-layout') === 'split' ? 'split' : 'unified'),
  set: (layout: 'unified' | 'split') => writeValue('centurion-diff-layout', layout === 'split' ? 'split' : null),
};

/** "Commit all" without asking, when nothing is staged (chosen once with "Always"). */
export const commitAllAlways = {
  get: () => readValue('centurion-commit-all') === 'always',
  set: (on: boolean) => writeValue('centurion-commit-all', on ? 'always' : null),
};

// ---------- requests to open a file (from transcript links) ----------

/** `line`: open the file at that line (links from visuals). */
export type OpenRequest = { agentId: string; path: string; mode: 'file' | 'diff'; line?: number };
const openListeners = new Set<(r: OpenRequest) => void>();

export const fileLinks = {
  open(r: OpenRequest): void {
    for (const fn of openListeners) fn(r);
  },
  on(fn: (r: OpenRequest) => void): () => void {
    openListeners.add(fn);
    return () => openListeners.delete(fn);
  },
};

// ---------- tools that change files ----------

export const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** The file a tool call changes, if it is one of the editing tools. */
export function editedPath(name: string, input: Record<string, unknown>): string | null {
  if (!EDIT_TOOLS.has(name)) return null;
  const p = input.file_path ?? input.notebook_path;
  return typeof p === 'string' ? p : null;
}
