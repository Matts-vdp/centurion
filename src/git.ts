import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { countLines, FileError, isBinary, MAX_TEXT, relParts, resolveInside, toPosix } from './confine.js';

/**
 * Git for the Files panel: status, diffs, the log, commit details and branches (the reads; writes are in `gitwrite.ts`).
 * Git runs as `git` itself, without a shell. A folder that isn't in a repository, or a machine without git,
 * just has no git state: `gitStatus` gives null and the other reads refuse with 400.
 *
 * Paths: `GitStatus.files` and the diff route are relative to the agent's folder (the root), like the file
 * routes; everything else (the status groups, the log, commits) is relative to the repository.
 */

export type GitLetter = 'M' | 'A' | 'D' | 'R' | 'U' | 'C';

/** A changed file in the root, path relative to it, with its line counts against HEAD (the tree marks and the old Changes tab). */
export type GitFile = { path: string; status: GitLetter; added: number | null; removed: number | null; oldPath?: string };

/** One side of a change, path relative to the repository. `code` is git's two-letter state of a conflict (`UU`, `AA`, `DU`, …). */
export type GitEntry = { path: string; status: GitLetter; added: number | null; removed: number | null; oldPath?: string; code?: string };

export type GitGroups = { conflicts: GitEntry[]; staged: GitEntry[]; unstaged: GitEntry[] };

export type GitOperation = {
  kind: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'am';
  /** What comes in: the branch being merged, the branch or commit rebased onto, the commit picked or reverted. */
  onto: string | null;
  /** Rebases: the commit being applied and how many there are. */
  step: number | null;
  total: number | null;
  /** Rebases: the branch being rebased (HEAD is detached meanwhile). */
  branch: string | null;
  /** Git has no durable actor metadata; distinguishes actions started in this manager from outside it. */
  startedBy: 'Centurion' | 'external';
};

const operationStarters = new Map<string, GitOperation['startedBy']>();
export function markOperationStarted(top: string): void { operationStarters.set(top, 'Centurion'); }

export type GitStatus = GitGroups & {
  /** The branch, or null when HEAD is detached. An unborn branch (no commits yet) has its name. */
  branch: string | null;
  detached: boolean;
  /** HEAD's commit, null without commits. */
  head: string | null;
  /** HEAD is on a remote-tracking branch, so amending or undoing it would need a force push. */
  headPushed: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** When the repository was last fetched (FETCH_HEAD's mtime, ms), or null. */
  fetchedAt: number | null;
  operation: GitOperation | null;
  /** The root's path inside the repository (`''` at the top, else ending in `/`). */
  prefix: string;
  /** Changes in the repository outside the root (only when the root is a subfolder). */
  outside: GitGroups;
  files: GitFile[];
};

const GIT_TIMEOUT = 10_000;
/** Git's empty tree, to diff against in a repository without commits. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const LOG_PAGE = 200;
/** A filtered log searches this many of the newest commits. */
const LOG_SCAN = 50_000;
const MAX_COUNTED = 200;

// ---------- running git ----------

export type GitResult = { code: number; stdout: Buffer; stderr: string };
export type GitOptions = {
  input?: string;
  timeout?: number;
  /** Writes take git's locks; reads skip the optional ones. */
  write?: boolean;
  env?: Record<string, string>;
  signal?: AbortSignal;
};

/** Run git in `cwd`. Rejects only when git can't be started (not installed) or times out. */
export function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    let child;
    const env = { ...process.env, ...(opts.write ? {} : { GIT_OPTIONAL_LOCKS: '0' }), ...opts.env };
    try {
      child = spawn('git', ['-c', 'core.quotepath=off', ...args], { cwd, windowsHide: true, env });
    } catch (err) {
      reject(err);
      return;
    }
    const out: Buffer[] = [];
    let err = '';
    const stop = () => {
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        killer.on('error', () => child.kill());
        killer.on('close', (code) => { if (code !== 0) child.kill(); });
      } else child.kill();
    };
    const timer = setTimeout(() => {
      stop();
      reject(new Error('git timed out'));
    }, opts.timeout ?? GIT_TIMEOUT);
    const abort = () => stop();
    if (opts.signal?.aborted) abort();
    opts.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
      resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** git, but any failure (no git, not a repo, a timeout) becomes null. */
export async function tryGit(cwd: string, args: string[], opts?: GitOptions): Promise<GitResult | null> {
  try {
    return await git(cwd, args, opts);
  } catch {
    return null;
  }
}

/** git's output when it exits 0, else null. */
async function gitText(cwd: string, args: string[]): Promise<string | null> {
  const res = await tryGit(cwd, args);
  return res && res.code === 0 ? res.stdout.toString('utf8') : null;
}

// ---------- the repository ----------

export type RepoInfo = { top: string; prefix: string; hasHead: boolean };
const repoCache = new Map<string, { at: number; info: RepoInfo | null }>();

/** Whether `root` is inside a git work tree, the repository's top folder and the root's path within it. Cached for a few seconds. */
export async function repoInfo(root: string): Promise<RepoInfo | null> {
  const hit = repoCache.get(root);
  if (hit && Date.now() - hit.at < 5000) return hit.info;
  let info: RepoInfo | null = null;
  const inside = await gitText(root, ['rev-parse', '--is-inside-work-tree', '--show-prefix', '--show-toplevel']);
  if (inside) {
    const [flag, prefix = '', top = ''] = inside.split(/\r?\n/);
    if (flag === 'true' && top) {
      const head = await tryGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
      info = { top: path.resolve(top), prefix, hasHead: head?.code === 0 };
    }
  }
  repoCache.set(root, { at: Date.now(), info });
  return info;
}

/** Forget the cached repository info and statuses (after a write: the first commit gives a repository its HEAD). */
export function forgetGitCaches(): void {
  repoCache.clear();
  statusCache.clear();
}

export async function needRepo(root: string): Promise<RepoInfo> {
  const repo = await repoInfo(root);
  if (!repo) throw new FileError(400, 'Not a git repository');
  return repo;
}

/** Which of `names` (relative to root, folders with a trailing slash) git ignores. */
export async function ignoredPaths(root: string, names: string[]): Promise<Set<string>> {
  if (names.length === 0 || !(await repoInfo(root))) return new Set();
  const res = await tryGit(root, ['check-ignore', '-z', '--stdin'], { input: names.join('\0') + '\0' });
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

/** Tracked and untracked (not ignored) files under root, relative to it; null outside git. */
export async function listedFiles(root: string): Promise<string[] | null> {
  if (!(await repoInfo(root))) return null;
  const out = await gitText(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  return out === null ? null : [...new Set(out.split('\0').filter(Boolean))];
}

// ---------- status ----------

/** The combined letter of a porcelain `XY` pair (the tree marks). */
function letter(xy: string): GitLetter {
  if (xy.includes('D')) return 'D';
  if (xy.includes('R') || xy.includes('C')) return 'R';
  if (xy.includes('A')) return 'A';
  return 'M';
}

/** The letter of one side (`X` or `Y`). */
function sideLetter(c: string): GitLetter {
  if (c === 'A' || c === 'D' || c === 'R') return c;
  if (c === 'C') return 'R'; // a copy: shown like a rename
  return 'M'; // M, T (type change)
}

type Counts = Map<string, [number | null, number | null]>;

/** `git diff --numstat -z …` as counts per (new) path, relative to the repository. */
async function numstat(top: string, args: string[]): Promise<Counts> {
  const counts: Counts = new Map();
  const out = await gitText(top, ['diff', '--numstat', '-z', ...args]);
  if (out === null) return counts;
  const parts = out.split('\0');
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
  return counts;
}

const statusCache = new Map<string, { at: number; status: Promise<GitStatus | null> }>();

/** The repository's state as seen from `root`. Null when it isn't a repository. */
export function gitStatus(root: string, fresh = false): Promise<GitStatus | null> {
  const hit = statusCache.get(root);
  if (!fresh && hit && Date.now() - hit.at < 1500) return hit.status;
  const status = loadStatus(root);
  statusCache.set(root, { at: Date.now(), status });
  return status;
}

const emptyGroups = (): GitGroups => ({ conflicts: [], staged: [], unstaged: [] });

async function loadStatus(root: string): Promise<GitStatus | null> {
  const repo = await repoInfo(root);
  if (!repo) return null;
  const { top, prefix } = repo;
  const base = repo.hasHead ? 'HEAD' : EMPTY_TREE;
  // Everything runs from the top, so paths are relative to the repository whatever `diff.relative` says.
  const [res, headCounts, stagedCounts, unstagedCounts, state, pushed] = await Promise.all([
    tryGit(top, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']),
    numstat(top, [base]),
    numstat(top, ['--cached', base]),
    numstat(top, []),
    repoState(top),
    repo.hasHead ? gitText(top, ['for-each-ref', '--contains', 'HEAD', '--count=1', '--format=%(refname)', 'refs/remotes']) : null,
  ]);
  if (!res || res.code !== 0) return null;

  const result: GitStatus = {
    branch: null,
    detached: false,
    head: null,
    headPushed: !!pushed?.trim(),
    upstream: null,
    ahead: 0,
    behind: 0,
    fetchedAt: state.fetchedAt,
    operation: state.operation,
    prefix,
    ...emptyGroups(),
    outside: emptyGroups(),
    files: [],
  };
  const inRoot = (p: string) => !prefix || p.startsWith(prefix);
  const strip = (p: string) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p);
  const counted = (counts: Counts, p: string): Pick<GitEntry, 'added' | 'removed'> => {
    const c = counts.get(p);
    return { added: c ? c[0] : null, removed: c ? c[1] : null };
  };
  /** Untracked files in the root, to count their lines once for both lists. */
  const untracked: { entry: GitEntry; file: GitFile }[] = [];

  const add = (p: string, xy: string, kind: 'change' | 'conflict' | 'untracked', oldPath?: string) => {
    const inside = inRoot(p);
    const groups: GitGroups = inside ? result : result.outside;
    if (kind === 'conflict') {
      groups.conflicts.push({ path: p, status: 'C', added: null, removed: null, code: xy });
    } else if (kind === 'untracked') {
      const entry: GitEntry = { path: p, status: 'U', added: null, removed: null };
      groups.unstaged.push(entry);
      if (inside) {
        const file: GitFile = { path: strip(p), status: 'U', added: null, removed: null };
        result.files.push(file);
        untracked.push({ entry, file });
      }
      return;
    } else {
      const [x, y] = xy;
      if (x !== '.') groups.staged.push({ path: p, status: sideLetter(x), ...counted(stagedCounts, p), ...(oldPath && x === 'R' ? { oldPath } : {}) });
      if (y !== '.') groups.unstaged.push({ path: p, status: sideLetter(y), ...counted(unstagedCounts, p), ...(oldPath && y === 'R' ? { oldPath } : {}) });
    }
    if (inside) {
      result.files.push({
        path: strip(p),
        status: kind === 'conflict' ? 'C' : letter(xy),
        ...counted(headCounts, p),
        ...(oldPath ? { oldPath: strip(oldPath) } : {}),
      });
    }
  };

  const fields = res.stdout.toString('utf8').split('\0');
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f) continue;
    if (f.startsWith('# branch.oid ')) {
      const oid = f.slice('# branch.oid '.length);
      result.head = oid === '(initial)' ? null : oid;
    } else if (f.startsWith('# branch.head ')) {
      const head = f.slice('# branch.head '.length);
      result.detached = head === '(detached)';
      result.branch = result.detached ? null : head;
    } else if (f.startsWith('# branch.upstream ')) {
      result.upstream = f.slice('# branch.upstream '.length);
    } else if (f.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(f);
      if (m) [result.ahead, result.behind] = [Number(m[1]), Number(m[2])];
    } else if (f.startsWith('1 ')) {
      const parts = f.split(' ');
      add(parts.slice(8).join(' '), parts[1], 'change');
    } else if (f.startsWith('2 ')) {
      const parts = f.split(' ');
      const oldPath = fields[++i] ?? '';
      add(parts.slice(9).join(' '), parts[1], 'change', oldPath);
    } else if (f.startsWith('u ')) {
      const parts = f.split(' ');
      add(parts.slice(10).join(' '), parts[1], 'conflict');
    } else if (f.startsWith('? ')) {
      add(f.slice(2), '??', 'untracked');
    }
  }

  // Untracked files have no numstat: count their lines (in the root only, and not too many).
  await Promise.all(
    untracked.slice(0, MAX_COUNTED).map(async ({ entry, file }) => {
      const text = await readUntracked(path.join(top, entry.path));
      if (!text || text.binary || text.truncated) return;
      entry.added = file.added = countLines(text.text);
      entry.removed = file.removed = 0;
    }),
  );

  const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
  for (const groups of [result, result.outside]) for (const list of [groups.conflicts, groups.staged, groups.unstaged]) list.sort(byPath);
  result.files.sort(byPath);
  return result;
}

/** A file's first MB as text, or binary; null when it can't be read. */
async function readUntracked(full: string): Promise<{ text: string; binary: boolean; truncated: boolean } | null> {
  try {
    const s = await stat(full);
    if (!s.isFile()) return null;
    const handle = await open(full, 'r');
    try {
      const length = Math.min(s.size, MAX_TEXT);
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, 0);
      const data = buf.subarray(0, bytesRead);
      if (isBinary(data)) return { text: '', binary: true, truncated: false };
      let text = data.toString('utf8');
      const truncated = s.size > MAX_TEXT;
      if (truncated) text = text.slice(0, Math.max(0, text.lastIndexOf('\n')));
      return { text, binary: false, truncated };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

// ---------- operation state ----------

const readTrim = (p: string) => readFile(p, 'utf8').then((s) => s.trim(), () => null);
const isDir = (p: string) => stat(p).then((s) => s.isDirectory(), () => false);
const exists = (p: string) => stat(p).then(() => true, () => false);
const toNumber = (s: string | null) => (s && /^\d+$/.test(s) ? Number(s) : null);
const short = (hash: string) => hash.slice(0, 7);

/** A merge, rebase, cherry-pick or revert in progress (from git's own files, so one started elsewhere shows too), and the last fetch. */
async function repoState(top: string): Promise<{ operation: GitOperation | null; fetchedAt: number | null }> {
  const names = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'MERGE_MSG', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'FETCH_HEAD'];
  // --git-path follows worktrees and relocated git dirs; its paths are relative to the cwd.
  const out = await gitText(top, ['rev-parse', ...names.flatMap((n) => ['--git-path', n])]);
  if (!out) return { operation: null, fetchedAt: null };
  const [rebaseMerge, rebaseApply, mergeHead, mergeMsg, pickHead, revertHead, fetchHead] = out
    .split(/\r?\n/)
    .slice(0, names.length)
    .map((p) => path.resolve(top, p));
  const fetchedAt = await stat(fetchHead).then((s) => Math.round(s.mtimeMs), () => null);
  const operation = await operationOf();
  if (!operation) operationStarters.delete(top);
  else operation.startedBy = operationStarters.get(top) ?? 'external';
  return { operation, fetchedAt };

  async function operationOf(): Promise<GitOperation | null> {
    for (const dir of [rebaseMerge, rebaseApply]) {
      if (!(await isDir(dir))) continue;
      const apply = dir === rebaseApply;
      if (apply && (await exists(path.join(dir, 'applying')))) return { kind: 'am', onto: null, step: null, total: null, branch: null, startedBy: 'external' };
      const [headName, onto, step, total] = await Promise.all(
        ['head-name', 'onto', apply ? 'next' : 'msgnum', apply ? 'last' : 'end'].map((f) => readTrim(path.join(dir, f))),
      );
      return {
        kind: 'rebase',
        onto: onto ? await nameOf(top, onto) : null,
        step: toNumber(step),
        total: toNumber(total),
        branch: headName?.startsWith('refs/heads/') ? headName.slice('refs/heads/'.length) : null,
        startedBy: 'external',
      };
    }
    const merge = await readTrim(mergeHead);
    if (merge) {
      const message = (await readTrim(mergeMsg)) ?? '';
      const named = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(message)?.[1];
      return { kind: 'merge', onto: named ?? (await nameOf(top, merge.split(/\s+/)[0])), step: null, total: null, branch: null, startedBy: 'external' };
    }
    const pick = await readTrim(pickHead);
    if (pick) return { kind: 'cherry-pick', onto: short(pick), step: null, total: null, branch: null, startedBy: 'external' };
    const revert = await readTrim(revertHead);
    if (revert) return { kind: 'revert', onto: short(revert), step: null, total: null, branch: null, startedBy: 'external' };
    return null;
  }
}

/** A branch pointing at `hash` (local first, then remote), else its short hash. */
async function nameOf(top: string, hash: string): Promise<string> {
  const out = await gitText(top, ['for-each-ref', `--points-at=${hash}`, '--format=%(refname)', 'refs/heads', 'refs/remotes']);
  const refs = (out ?? '').split(/\r?\n/).filter((r) => r && !r.endsWith('/HEAD'));
  const local = refs.find((r) => r.startsWith('refs/heads/'));
  if (local) return local.slice('refs/heads/'.length);
  const remote = refs.find((r) => r.startsWith('refs/remotes/'));
  if (remote) return remote.slice('refs/remotes/'.length);
  return short(hash);
}

// ---------- diffs ----------

export type DiffSide = 'head' | 'staged' | 'worktree';
export const DIFF_SIDES: DiffSide[] = ['head', 'staged', 'worktree'];
export type DiffOptions = { side?: DiffSide; context?: number; ignoreWhitespace?: boolean };
export type FileDiff = {
  diff: string;
  status: GitLetter | null;
  binary: boolean;
  truncated: boolean;
  /** sha1 of the whole diff (before truncation), so a later write can tell the file changed since. */
  hash: string;
  /** Binary files: the size in bytes of each side, null where the side doesn't exist. */
  sizes?: { old: number | null; new: number | null };
};

/** Hunks only (the file headers dropped: the panel shows the path itself), truncated, with the hash. */
function finishDiff(raw: string, status: GitLetter | null): FileDiff {
  const binary = /^Binary files /m.test(raw);
  const start = raw.search(/^@@/m);
  let diff = start >= 0 ? raw.slice(start) : '';
  const hash = createHash('sha1').update(diff).digest('hex');
  const truncated = diff.length > MAX_TEXT;
  if (truncated) diff = diff.slice(0, MAX_TEXT);
  return { diff, status, binary, truncated, hash };
}

/** An untracked file as all added. */
async function addedDiff(full: string): Promise<FileDiff> {
  const content = await readUntracked(full);
  if (!content || content.binary) return { ...finishDiff('', 'U'), binary: true };
  const lines = content.text.split('\n');
  if (content.text.endsWith('\n')) lines.pop();
  const result = finishDiff([`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n'), 'U');
  return { ...result, truncated: result.truncated || content.truncated };
}

/**
 * A file's unified diff, `rel` relative to the root. `head`: HEAD ↔ working tree (the default);
 * `staged`: HEAD ↔ index; `worktree`: index ↔ working tree. An untracked file comes back as all added.
 */
export async function fileDiff(root: string, rel: string, opts: DiffOptions = {}): Promise<FileDiff> {
  const repo = await needRepo(root);
  const side = opts.side ?? 'head';
  // The file may be deleted, so it only has to be inside the root by name.
  const full = await resolveInside(root, rel, false);
  const relPosix = toPosix(path.relative(root, full));
  const repoPath = repo.prefix + relPosix;
  const status = await gitStatus(root, true);
  const file = status?.files.find((f) => f.path === relPosix) ?? null;
  const conflict = status?.conflicts.find((e) => e.path === repoPath);
  const entry =
    side === 'head'
      ? file
      : (conflict ?? (side === 'staged' ? status?.staged : status?.unstaged)?.find((e) => e.path === repoPath) ?? null);
  if (file?.status === 'U') {
    if (side === 'staged') return finishDiff('', null);
    await resolveInside(root, rel);
    const added = await addedDiff(full);
    if (added.binary) added.sizes = { old: null, new: await stat(full).then((s) => s.size, () => null) };
    return added;
  }
  const base = repo.hasHead ? 'HEAD' : EMPTY_TREE;
  const args = ['--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff'];
  if (opts.context !== undefined) args.push(`-U${opts.context}`);
  if (opts.ignoreWhitespace) args.push('-w');
  if (side === 'staged') args.push('--cached', base);
  else if (side === 'head') args.push(base);
  // A staged rename diffs against its old path, which git only pairs up when both are in the pathspec.
  const oldPath = side !== 'worktree' ? status?.staged.find((e) => e.path === repoPath)?.oldPath : undefined;
  const res = await tryGit(repo.top, [...args, '-M', '--', ...(oldPath ? [oldPath] : []), repoPath]);
  if (!res || res.code !== 0) throw new FileError(500, res?.stderr.trim() || 'git diff failed');
  const result = finishDiff(res.stdout.toString('utf8'), entry?.status ?? null);
  if (result.binary) {
    // HEAD (or the index, for the working-tree side) against the index (staged) or the working tree.
    const blobSize = async (spec: string) => {
      const r = await tryGit(repo.top, ['cat-file', '-s', spec]);
      return r && r.code === 0 ? Number(r.stdout.toString('utf8').trim()) : null;
    };
    const oldSize = side === 'worktree' ? blobSize(`:${repoPath}`) : repo.hasHead ? blobSize(`HEAD:${oldPath ?? repoPath}`) : Promise.resolve(null);
    const newSize = side === 'staged' ? blobSize(`:${repoPath}`) : stat(full).then((s) => (s.isFile() ? s.size : null), () => null);
    result.sizes = { old: await oldSize, new: await newSize };
  }
  return result;
}

/**
 * The text a diff's context lines come from (its new side), for showing more context in the UI:
 * the working tree for `head` and `worktree`, the index for `staged`. The first MB; null for a binary file.
 */
export async function diffSideText(root: string, rel: string, side: DiffSide): Promise<{ text: string; truncated: boolean } | null> {
  const repo = await needRepo(root);
  const full = await resolveInside(root, rel, side === 'staged' ? false : true);
  if (side !== 'staged') {
    const content = await readUntracked(full);
    if (!content) throw new FileError(404, 'The file is gone');
    return content.binary ? null : { text: content.text, truncated: content.truncated };
  }
  const repoPath = repo.prefix + toPosix(path.relative(root, full));
  const res = await tryGit(repo.top, ['cat-file', 'blob', `:${repoPath}`]);
  if (!res || res.code !== 0) throw new FileError(404, 'The file is not in the index');
  const data = res.stdout.subarray(0, MAX_TEXT);
  if (isBinary(data)) return null;
  let text = data.toString('utf8');
  const truncated = res.stdout.length > MAX_TEXT;
  if (truncated) text = text.slice(0, Math.max(0, text.lastIndexOf('\n')));
  return { text, truncated };
}

// ---------- log ----------

export type GitRef = { name: string; kind: 'branch' | 'remote' | 'tag' | 'head'; /** HEAD points at this branch. */ head?: boolean };
export type LogCommit = {
  hash: string;
  parents: string[];
  subject: string;
  author: string;
  email: string;
  /** Author date, ISO 8601. */
  date: string;
  refs: GitRef[];
  /** Reachable from a remote-tracking branch, so rewriting it would need a force push. */
  pushed: boolean;
  /** On the current branch's upstream but not in HEAD: what a pull would bring. */
  incoming: boolean;
};
export type LogQuery = { scope?: 'branch' | 'all'; skip?: number; filter?: string; range?: string };

const SEP = '\x1f';
const REC = '\x1e';
const DECORATE = ['--decorate=full', '--decorate-refs-exclude=refs/stash'];

/** `%D` with full ref names, as refs. Remote `HEAD`s and other refs (stash, notes) are left out. */
function parseRefs(d: string): GitRef[] {
  const refs: GitRef[] = [];
  for (const part of d.split(', ').filter(Boolean)) {
    if (part === 'HEAD') refs.push({ name: 'HEAD', kind: 'head' });
    else if (part.startsWith('HEAD -> ')) {
      const ref = part.slice('HEAD -> '.length);
      if (ref.startsWith('refs/heads/')) refs.push({ name: ref.slice('refs/heads/'.length), kind: 'branch', head: true });
    } else if (part.startsWith('tag: refs/tags/')) refs.push({ name: part.slice('tag: refs/tags/'.length), kind: 'tag' });
    else if (part.startsWith('refs/heads/')) refs.push({ name: part.slice('refs/heads/'.length), kind: 'branch' });
    else if (part.startsWith('refs/remotes/') && !part.endsWith('/HEAD')) refs.push({ name: part.slice('refs/remotes/'.length), kind: 'remote' });
  }
  return refs;
}

/** Revisions and ranges the log accepts (`main`, `origin/main..HEAD`, `abc123~3`): never an option. */
const RANGE = /^[\w./@^~{}+-]+(?:\.\.\.?[\w./@^~{}+-]*)?$|^\.\.\.?[\w./@^~{}+-]+$/;

/** Commits, newest first in topological order, 200 per page. `filter` matches the subject, author and hash. */
export async function gitLog(root: string, q: LogQuery): Promise<{ commits: LogCommit[]; more: boolean }> {
  const repo = await needRepo(root);
  const { top } = repo;
  const range = q.range?.trim() ?? '';
  if (range && (!RANGE.test(range) || /(^|\.\.)-/.test(range))) throw new FileError(400, `Not a range: ${range}`);
  const skip = Math.max(0, Math.floor(q.skip ?? 0));
  const filter = q.filter?.trim().toLowerCase() ?? '';

  const upstream = repo.hasHead ? (await tryGit(top, ['rev-parse', '--verify', '--quiet', '@{upstream}']))?.code === 0 : false;
  let tips: string[];
  if (range) tips = [range];
  else if (q.scope === 'all') tips = ['--branches', '--remotes', '--tags', ...(repo.hasHead ? ['HEAD'] : [])];
  else if (!repo.hasHead) return { commits: [], more: false };
  else tips = ['HEAD', ...(upstream ? ['@{upstream}'] : [])];

  const format = ['%H', '%P', '%s', '%an', '%ae', '%aI', '%D'].join('%x1f') + '%x1e';
  const limit = filter ? ['--max-count=' + LOG_SCAN] : [`--skip=${skip}`, `--max-count=${LOG_PAGE + 1}`];
  const res = await tryGit(top, ['log', '--topo-order', `--format=${format}`, ...DECORATE, ...limit, ...tips, '--']);
  if (!res) throw new FileError(500, 'git log failed');
  if (res.code !== 0) {
    if (/does not have any commits/.test(res.stderr)) return { commits: [], more: false };
    throw new FileError(400, res.stderr.trim() || 'git log failed');
  }

  let commits: LogCommit[] = res.stdout
    .toString('utf8')
    .split(REC)
    .map((r) => r.replace(/^\r?\n/, ''))
    .filter(Boolean)
    .map((r) => {
      const [hash, parents, subject, author, email, date, refs] = r.split(SEP);
      return {
        hash,
        parents: parents ? parents.split(' ') : [],
        subject,
        author,
        email,
        date,
        refs: parseRefs(refs ?? ''),
        pushed: false,
        incoming: false,
      };
    });
  if (filter) {
    commits = commits.filter(
      (c) =>
        c.subject.toLowerCase().includes(filter) ||
        c.author.toLowerCase().includes(filter) ||
        c.email.toLowerCase().includes(filter) ||
        c.hash.startsWith(filter),
    );
    commits = commits.slice(skip, skip + LOG_PAGE + 1);
  }
  const more = commits.length > LOG_PAGE;
  commits = commits.slice(0, LOG_PAGE);
  if (commits.length === 0) return { commits, more };

  // Pushed: on some remote-tracking branch. Without remotes nothing is.
  const hasRemotes = !!(await gitText(top, ['for-each-ref', '--count=1', '--format=x', 'refs/remotes']))?.trim();
  if (hasRemotes) {
    const local = await gitText(top, ['rev-list', ...tips, '--not', '--remotes', '--']);
    const unpushed = new Set((local ?? '').split(/\r?\n/).filter(Boolean));
    for (const c of commits) c.pushed = !unpushed.has(c.hash);
  }
  if (upstream) {
    const out = await gitText(top, ['rev-list', 'HEAD..@{upstream}', '--']);
    const incoming = new Set((out ?? '').split(/\r?\n/).filter(Boolean));
    for (const c of commits) c.incoming = incoming.has(c.hash);
  }
  return { commits, more };
}

// ---------- commit details ----------

export type CommitFile = GitEntry & { /** Inside the agent's folder, so its diff may open. */ inside: boolean };
export type CommitDetails = {
  hash: string;
  parents: string[];
  subject: string;
  body: string;
  author: { name: string; email: string; date: string };
  committer: { name: string; email: string; date: string };
  refs: GitRef[];
  /** Changed files against the first parent (a root commit: everything added). */
  files: CommitFile[];
};

const HASH = /^[0-9a-fA-F]{4,64}$/;

/** A commit's message, meta and changed files (paths relative to the repository). */
export async function gitCommit(root: string, hash: string): Promise<CommitDetails> {
  const repo = await needRepo(root);
  const { top, prefix } = repo;
  if (!HASH.test(hash)) throw new FileError(400, 'Not a commit hash');
  const format = ['%H', '%P', '%s', '%an', '%ae', '%aI', '%cn', '%ce', '%cI', '%D', '%b'].join('%x1f');
  const res = await tryGit(top, ['show', '-s', ...DECORATE, `--format=${format}`, `${hash}^{commit}`, '--']);
  if (!res || res.code !== 0) throw new FileError(404, `No such commit: ${hash}`);
  const [full, parents, subject, an, ae, ad, cn, ce, cd, refs, ...body] = res.stdout.toString('utf8').split(SEP);
  const parentList = parents ? parents.split(' ') : [];
  const base = parentList[0] ?? EMPTY_TREE;

  const [names, counts] = await Promise.all([
    gitText(top, ['diff', '--name-status', '-z', '-M', base, full, '--']),
    numstat(top, ['-M', base, full, '--']),
  ]);
  const files: CommitFile[] = [];
  const parts = (names ?? '').split('\0');
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code) continue;
    const kind = code[0];
    let p = parts[++i] ?? '';
    let oldPath: string | undefined;
    if (kind === 'R' || kind === 'C') {
      oldPath = p;
      p = parts[++i] ?? '';
    }
    const c = counts.get(p);
    files.push({
      path: p,
      status: kind === 'A' || kind === 'D' ? kind : kind === 'R' || kind === 'C' ? 'R' : 'M',
      added: c ? c[0] : null,
      removed: c ? c[1] : null,
      ...(oldPath && kind === 'R' ? { oldPath } : {}),
      inside: !prefix || p.startsWith(prefix),
    });
  }
  return {
    hash: full,
    parents: parentList,
    subject,
    body: body.join(SEP).replace(/\s+$/, ''),
    author: { name: an, email: ae, date: ad },
    committer: { name: cn, email: ce, date: cd },
    refs: parseRefs(refs ?? ''),
    files,
  };
}

/** One file's diff in a commit against its first parent. `file` is relative to the repository and must be inside the root. */
export async function commitFileDiff(root: string, hash: string, file: string): Promise<FileDiff> {
  const repo = await needRepo(root);
  const p = relParts(file).join('/');
  if (repo.prefix && !p.startsWith(repo.prefix)) throw new FileError(403, "That file is outside the agent's folder");
  const details = await gitCommit(root, hash);
  const entry = details.files.find((f) => f.path === p);
  if (!entry) throw new FileError(404, `${p} didn't change in ${short(details.hash)}`);
  const base = details.parents[0] ?? EMPTY_TREE;
  const paths = entry.oldPath ? [entry.oldPath, p] : [p];
  const res = await tryGit(repo.top, ['--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff', '-M', base, details.hash, '--', ...paths]);
  if (!res || res.code !== 0) throw new FileError(500, res?.stderr.trim() || 'git diff failed');
  return finishDiff(res.stdout.toString('utf8'), entry.status);
}

// ---------- branches ----------

export type LocalBranch = {
  name: string;
  hash: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** The upstream was deleted on the remote. */
  gone: boolean;
  current: boolean;
  date: string;
  subject: string;
};
export type RemoteBranch = { name: string; remote: string; hash: string; date: string; subject: string };
export type Branches = { current: string | null; default: string | null; remotes: string[]; local: LocalBranch[]; remote: RemoteBranch[] };

/** Local and remote-tracking branches, with ahead/behind against each one's upstream. */
export async function gitBranches(root: string): Promise<Branches> {
  const { top } = await needRepo(root);
  const format = ['%(refname)', '%(objectname)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(HEAD)', '%(committerdate:iso-strict)', '%(symref)', '%(subject)'].join(
    '%1f',
  );
  const [refsOut, current, originHead, remotesOut] = await Promise.all([
    gitText(top, ['for-each-ref', `--format=${format}`, 'refs/heads', 'refs/remotes']),
    gitText(top, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    gitText(top, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']),
    gitText(top, ['remote']),
  ]);
  const local: LocalBranch[] = [];
  const remote: RemoteBranch[] = [];
  for (const line of (refsOut ?? '').split(/\r?\n/)) {
    if (!line) continue;
    const [ref, hash, upstream, track, head, date, symref, ...subject] = line.split(SEP);
    if (symref) continue; // origin/HEAD and the like
    if (ref.startsWith('refs/heads/')) {
      local.push({
        name: ref.slice('refs/heads/'.length),
        hash,
        upstream: upstream || null,
        ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
        behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
        gone: track === 'gone',
        current: head === '*',
        date,
        subject: subject.join(SEP),
      });
    } else if (ref.startsWith('refs/remotes/')) {
      const name = ref.slice('refs/remotes/'.length);
      remote.push({ name, remote: name.split('/')[0], hash, date, subject: subject.join(SEP) });
    }
  }
  local.sort((a, b) => (a.current !== b.current ? (a.current ? -1 : 1) : a.name.localeCompare(b.name)));
  remote.sort((a, b) => a.name.localeCompare(b.name));

  // The default branch: origin's HEAD, else main, else master (local or on origin).
  let def: string | null = originHead?.trim().replace(/^refs\/remotes\/origin\//, '') || null;
  if (!def) {
    const has = (n: string) => local.some((b) => b.name === n) || remote.some((b) => b.name === `origin/${n}`);
    def = has('main') ? 'main' : has('master') ? 'master' : null;
  }
  return {
    current: current?.trim() || null,
    default: def,
    remotes: (remotesOut ?? '').split(/\r?\n/).filter(Boolean),
    local,
    remote,
  };
}
