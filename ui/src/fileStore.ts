import { useSyncExternalStore } from 'react';
import { api, token } from './api';

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
export type GitStatus = { branch: string | null; ahead: number; behind: number; files: GitFile[] };
export type FileContent =
  | { kind: 'text'; text: string; size: number; truncated: boolean; lines: number }
  | { kind: 'image'; size: number; mediaType: string }
  | { kind: 'binary'; size: number };
export type FileDiff = { diff: string; status: GitLetter | null; binary: boolean; truncated: boolean };

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
  diff: (id: string, root: number, path: string) => api<FileDiff>(`/api/agents/${id}/git/diff?${q(root, path)}`),
};

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
