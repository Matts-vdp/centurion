import { open, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { countLines, FileError, isBinary, MAX_TEXT, RawBody, resolveInside, toPosix } from './confine.js';
import { gitStatus, ignoredPaths, listedFiles, type GitLetter } from './git.js';

/**
 * Read-only access to an agent's folders for the Files panel: listings and file contents, with git marks.
 * Every path is relative to one of the agent's roots and must stay inside it (links included).
 * A folder that isn't a git repository, or a machine without git, just has no git fields. Git itself is in `git.ts`.
 */

export { FileError, isInside, RawBody, resolveInside } from './confine.js';
export type { GitLetter } from './git.js';

export type Entry = {
  name: string;
  type: 'dir' | 'file' | 'link';
  size: number;
  mtime: number;
  ignored: boolean;
  /** A file's git letter. */
  git?: GitLetter;
  /** A folder's number of changed files beneath it. */
  changes?: number;
};

const MAX_ENTRIES = 5000;
const MAX_ALL = 50_000;
const MAX_IMAGE = 20 * 1024 * 1024;
const SKIP_WALK = new Set(['.git', 'node_modules']);

export const IMAGE_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
};

// ---------- listings ----------

export async function listFolder(root: string, rel: string): Promise<{ entries: Entry[]; truncated: boolean }> {
  const dir = await resolveInside(root, rel);
  const s = await stat(dir);
  if (!s.isDirectory()) throw new FileError(400, 'Not a folder');
  const dirents = await readdir(dir, { withFileTypes: true });
  const all = dirents.filter((d) => d.name !== '.git');
  const visible = all.slice(0, MAX_ENTRIES);
  const relBase = toPosix(path.relative(root, dir));
  const relOf = (name: string) => (relBase ? `${relBase}/${name}` : name);

  const entries: Entry[] = await Promise.all(
    visible.map(async (d): Promise<Entry> => {
      let type: Entry['type'] = d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'link' : 'file';
      let size = 0;
      let mtime = 0;
      try {
        const st = await stat(path.join(dir, d.name)); // follows links
        size = st.size;
        mtime = st.mtimeMs;
        if (type === 'link' && st.isDirectory()) type = 'dir';
        else if (type === 'link') type = 'file';
      } catch {
        // a broken link stays a link
      }
      return { name: d.name, type, size, mtime, ignored: false };
    }),
  );

  const [ignored, status] = await Promise.all([
    ignoredPaths(
      root,
      entries.map((e) => relOf(e.name) + (e.type === 'dir' ? '/' : '')),
    ),
    gitStatus(root),
  ]);
  for (const e of entries) {
    const p = relOf(e.name);
    e.ignored = ignored.has(p);
    if (!status) continue;
    if (e.type === 'dir') {
      const n = status.files.filter((f) => f.path.startsWith(p + '/')).length;
      if (n) e.changes = n;
    } else {
      const f = status.files.find((g) => g.path === p);
      if (f) e.git = f.status;
    }
  }
  // Deleted files aren't on disk; show them in their folder so the tree matches the changes.
  if (status) {
    for (const f of status.files) {
      if (f.status !== 'D') continue;
      const parent = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      if (parent !== relBase) continue;
      const name = f.path.slice(parent ? parent.length + 1 : 0);
      if (!entries.some((e) => e.name === name)) entries.push({ name, type: 'file', size: 0, mtime: 0, ignored: false, git: 'D' });
    }
  }
  entries.sort((a, b) => {
    if (a.ignored !== b.ignored) return a.ignored ? 1 : -1;
    if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  });
  return { entries, truncated: all.length > visible.length };
}

/** Every file under root, for the filter: git's tracked and untracked files, or a capped walk outside git. */
export async function allFiles(root: string): Promise<{ files: string[]; truncated: boolean }> {
  const listed = await listedFiles(root);
  if (listed) return { files: listed.slice(0, MAX_ALL), truncated: listed.length > MAX_ALL };
  const files: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    if (files.length >= MAX_ALL) return;
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (files.length >= MAX_ALL) return;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (!SKIP_WALK.has(d.name)) await walk(path.join(dir, d.name), r);
      } else if (d.isFile()) files.push(r);
    }
  };
  await walk(root, '');
  return { files, truncated: files.length >= MAX_ALL };
}

// ---------- reading ----------

export type FileContent =
  | { kind: 'text'; text: string; size: number; truncated: boolean; lines: number }
  | { kind: 'image'; size: number; mediaType: string }
  | { kind: 'binary'; size: number };

export async function readFileContent(root: string, rel: string, raw: boolean): Promise<FileContent | RawBody> {
  const full = await resolveInside(root, rel);
  const s = await stat(full);
  if (s.isDirectory()) throw new FileError(400, 'That is a folder');
  const mediaType = IMAGE_EXTENSIONS[path.extname(full).toLowerCase()];
  if (raw) {
    if (!mediaType) throw new FileError(400, 'Only images can be fetched raw');
    if (s.size > MAX_IMAGE) throw new FileError(413, 'The image is too large to show');
    return new RawBody(mediaType, await readFile(full));
  }
  if (mediaType) return { kind: 'image', size: s.size, mediaType };
  const handle = await open(full, 'r');
  try {
    const length = Math.min(s.size, MAX_TEXT);
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, 0);
    const data = buf.subarray(0, bytesRead);
    if (isBinary(data)) return { kind: 'binary', size: s.size };
    let text = data.toString('utf8');
    const truncated = s.size > MAX_TEXT;
    if (truncated) text = text.slice(0, Math.max(0, text.lastIndexOf('\n')));
    return { kind: 'text', text, size: s.size, truncated, lines: countLines(text) };
  } finally {
    await handle.close();
  }
}
