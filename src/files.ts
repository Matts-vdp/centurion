import { spawn } from 'node:child_process';
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Read-only access to an agent's folders for the Files panel: listings, file contents and git state.
 * Every path is relative to one of the agent's roots and must stay inside it (links included).
 * A folder that isn't a git repository, or a machine without git, just has no git fields.
 */

export class FileError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A response that isn't JSON (an image's bytes). */
export class RawBody {
  constructor(
    readonly type: string,
    readonly body: Buffer,
  ) {}
}

export type GitLetter = 'M' | 'A' | 'D' | 'R' | 'U' | 'C';

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

export type GitFile = { path: string; status: GitLetter; added: number | null; removed: number | null; oldPath?: string };
export type GitStatus = { branch: string | null; ahead: number; behind: number; files: GitFile[] };

const MAX_ENTRIES = 5000;
const MAX_ALL = 50_000;
const MAX_TEXT = 1024 * 1024;
const MAX_IMAGE = 20 * 1024 * 1024;
const GIT_TIMEOUT = 10_000;
/** Git's empty tree, to diff against in a repository without commits. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
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

// ---------- confinement ----------

/** The absolute path of `rel` inside `root`, refusing anything that resolves outside it. */
export async function resolveInside(root: string, rel: string, mustExist = true): Promise<string> {
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) throw new FileError(400, 'The path must be relative to the folder');
  const parts = rel.split(/[\\/]+/).filter((p) => p && p !== '.');
  if (parts.includes('..')) throw new FileError(400, 'The path may not contain ".."');
  const full = path.join(root, ...parts);
  if (!mustExist) return full;
  let real: string;
  let realRoot: string;
  try {
    [real, realRoot] = await Promise.all([realpath(full), realpath(root)]);
  } catch {
    throw new FileError(404, `Not found: ${rel || '.'}`);
  }
  if (!isInside(realRoot, real)) throw new FileError(403, 'That path leads outside the folder');
  return full;
}

function isInside(root: string, p: string): boolean {
  const a = process.platform === 'win32' ? root.toLowerCase() : root;
  const b = process.platform === 'win32' ? p.toLowerCase() : p;
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

// ---------- git ----------

type GitResult = { code: number; stdout: Buffer; stderr: string };

/** Run git in `cwd`. Rejects only when git can't be started (not installed) or times out. */
function git(cwd: string, args: string[], input?: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('git', ['-c', 'core.quotepath=off', ...args], { cwd, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    } catch (err) {
      reject(err);
      return;
    }
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('git timed out'));
    }, GIT_TIMEOUT);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** git, but any failure (no git, not a repo, a timeout) becomes null. */
async function tryGit(cwd: string, args: string[], input?: string): Promise<GitResult | null> {
  try {
    return await git(cwd, args, input);
  } catch {
    return null;
  }
}

type RepoInfo = { prefix: string; hasHead: boolean };
const repoCache = new Map<string, { at: number; info: RepoInfo | null }>();

/** Whether `root` is inside a git work tree, and its path within the repository. Cached for a few seconds. */
export async function repoInfo(root: string): Promise<RepoInfo | null> {
  const hit = repoCache.get(root);
  if (hit && Date.now() - hit.at < 5000) return hit.info;
  let info: RepoInfo | null = null;
  const inside = await tryGit(root, ['rev-parse', '--is-inside-work-tree', '--show-prefix']);
  if (inside && inside.code === 0) {
    const [flag, prefix = ''] = inside.stdout.toString().split(/\r?\n/);
    if (flag === 'true') {
      const head = await tryGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
      info = { prefix, hasHead: head?.code === 0 };
    }
  }
  repoCache.set(root, { at: Date.now(), info });
  return info;
}

function letter(xy: string): GitLetter {
  if (xy.includes('D')) return 'D';
  if (xy.includes('R') || xy.includes('C')) return 'R';
  if (xy.includes('A')) return 'A';
  return 'M';
}

const statusCache = new Map<string, { at: number; status: Promise<GitStatus | null> }>();

/** Changed files under `root` (paths relative to it), with line counts. Null when it isn't a repository. */
export function gitStatus(root: string, fresh = false): Promise<GitStatus | null> {
  const hit = statusCache.get(root);
  if (!fresh && hit && Date.now() - hit.at < 1500) return hit.status;
  const status = loadStatus(root);
  statusCache.set(root, { at: Date.now(), status });
  return status;
}

async function loadStatus(root: string): Promise<GitStatus | null> {
  const repo = await repoInfo(root);
  if (!repo) return null;
  const res = await tryGit(root, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--', '.']);
  if (!res || res.code !== 0) return null;
  const strip = (p: string) => (repo.prefix && p.startsWith(repo.prefix) ? p.slice(repo.prefix.length) : p);
  const fields = res.stdout.toString('utf8').split('\0');
  const result: GitStatus = { branch: null, ahead: 0, behind: 0, files: [] };
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f) continue;
    if (f.startsWith('# branch.head ')) {
      const head = f.slice('# branch.head '.length);
      result.branch = head === '(detached)' ? null : head;
    } else if (f.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(f);
      if (m) [result.ahead, result.behind] = [Number(m[1]), Number(m[2])];
    } else if (f.startsWith('1 ')) {
      const parts = f.split(' ');
      result.files.push({ path: strip(parts.slice(8).join(' ')), status: letter(parts[1]), added: null, removed: null });
    } else if (f.startsWith('2 ')) {
      const parts = f.split(' ');
      const oldPath = fields[++i];
      result.files.push({ path: strip(parts.slice(9).join(' ')), status: 'R', added: null, removed: null, oldPath: strip(oldPath ?? '') });
    } else if (f.startsWith('u ')) {
      const parts = f.split(' ');
      result.files.push({ path: strip(parts.slice(10).join(' ')), status: 'C', added: null, removed: null });
    } else if (f.startsWith('? ')) {
      result.files.push({ path: strip(f.slice(2)), status: 'U', added: null, removed: null });
    }
  }

  // Line counts: tracked files from numstat against HEAD, untracked ones by counting lines.
  const base = repo.hasHead ? 'HEAD' : EMPTY_TREE;
  const numstat = await tryGit(root, ['diff', '--numstat', '-z', '--relative', base, '--', '.']);
  if (numstat && numstat.code === 0) {
    const counts = new Map<string, [number | null, number | null]>();
    const parts = numstat.stdout.toString('utf8').split('\0');
    for (let i = 0; i < parts.length; i++) {
      const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(parts[i]);
      if (!m) continue;
      let p = m[3];
      if (p === '') {
        i += 2; // a rename: old and new path follow
        p = parts[i] ?? '';
      }
      counts.set(p, [m[1] === '-' ? null : Number(m[1]), m[2] === '-' ? null : Number(m[2])]);
    }
    for (const file of result.files) {
      const c = counts.get(file.path);
      if (c) [file.added, file.removed] = c;
    }
  }
  await Promise.all(
    result.files
      .filter((f) => f.status === 'U')
      .slice(0, 200)
      .map(async (f) => {
        try {
          const full = path.join(root, f.path);
          const s = await stat(full);
          if (s.size > MAX_TEXT) return;
          const buf = await readFile(full);
          if (isBinary(buf)) return;
          f.added = countLines(buf.toString('utf8'));
          f.removed = 0;
        } catch {
          // gone again: leave the counts out
        }
      }),
  );
  result.files.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}

/** Which of `names` (relative to root, folders with a trailing slash) git ignores. */
async function ignoredOf(root: string, names: string[]): Promise<Set<string>> {
  if (names.length === 0 || !(await repoInfo(root))) return new Set();
  const res = await tryGit(root, ['check-ignore', '-z', '--stdin'], names.join('\0') + '\0');
  // Exit 1 means nothing is ignored; anything else but 0 is an error, which we treat the same.
  if (!res || res.code !== 0) return new Set();
  return new Set(
    res.stdout
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((p) => p.replace(/\/$/, '')),
  );
}

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
    ignoredOf(
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
  if (await repoInfo(root)) {
    const res = await tryGit(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    if (res && res.code === 0) {
      const files = [...new Set(res.stdout.toString('utf8').split('\0').filter(Boolean))];
      return { files: files.slice(0, MAX_ALL), truncated: files.length > MAX_ALL };
    }
  }
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

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

function countLines(text: string): number {
  if (!text) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

// ---------- diffs ----------

export type FileDiff = { diff: string; status: GitLetter | null; binary: boolean; truncated: boolean };

/** The file's unified diff against HEAD. An untracked file comes back as all added. */
export async function fileDiff(root: string, rel: string): Promise<FileDiff> {
  const repo = await repoInfo(root);
  if (!repo) throw new FileError(400, 'Not a git repository');
  // The file may be deleted, so it only has to be inside the root by name.
  const full = await resolveInside(root, rel, false);
  const relPosix = toPosix(path.relative(root, full));
  const status = await gitStatus(root, true);
  const entry = status?.files.find((f) => f.path === relPosix) ?? null;
  if (entry?.status === 'U') {
    await resolveInside(root, rel);
    const content = await readFileContent(root, rel, false);
    if (content instanceof RawBody || content.kind !== 'text') return { diff: '', status: 'U', binary: true, truncated: false };
    const lines = content.text.split('\n');
    if (content.text.endsWith('\n')) lines.pop();
    const diff = [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n');
    return { diff, status: 'U', binary: false, truncated: content.truncated };
  }
  const base = repo.hasHead ? 'HEAD' : EMPTY_TREE;
  const res = await tryGit(root, ['diff', '--no-color', '--no-ext-diff', base, '--', relPosix]);
  if (!res || res.code !== 0) throw new FileError(500, res?.stderr.trim() || 'git diff failed');
  let diff = res.stdout.toString('utf8');
  const binary = /^Binary files /m.test(diff);
  const truncated = diff.length > MAX_TEXT;
  if (truncated) diff = diff.slice(0, MAX_TEXT);
  // Drop the file headers: the panel shows the path itself.
  const start = diff.search(/^@@/m);
  return { diff: start >= 0 ? diff.slice(start) : '', status: entry?.status ?? null, binary, truncated };
}
