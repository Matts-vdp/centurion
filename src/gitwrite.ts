import { EventEmitter } from 'node:events';
import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { FileError, relParts, resolveInside, toPosix } from './confine.js';
import { fileDiff, forgetGitCaches, git, gitStatus, needRepo, type GitEntry, type GitOptions, type GitResult, type GitStatus, type RepoInfo } from './git.js';

/**
 * Git writes for the Files panel (`docs/git-plan.md` §3, §4, §9): stage, unstage, discard, partial patches,
 * commit, amend and undo commit. Writes on one repository run one at a time (a promise queue keyed by the
 * repository's top folder), take git's locks, and retry once when git's `index.lock` is held.
 * Nothing here forces anything: no `reset --hard`, no `clean`, no `--no-verify`.
 *
 * Paths given to `stage`, `unstage` and `discard` are relative to the repository; `apply` takes the root-relative
 * path of the diff it was shown, like the diff route.
 */

/** A git command a write ran, for the UI's Details. */
export type GitCommand = { command: string; code: number; output: string };

/** What every write returns: the repository's new status and the commands that ran. */
export type WriteResult = { status: GitStatus | null; commands: GitCommand[] };

/** A failed write: a plain sentence as the message, git's own output as `details`. */
export class GitError extends FileError {
  constructor(
    status: number,
    message: string,
    readonly details = '',
    public commands: GitCommand[] = [],
  ) {
    super(status, message);
  }
}

/** `write` (`{ top }`) after every write that ran a git command, failed or not, so other panes on that repository refresh. */
export const gitEvents = new EventEmitter();

const LOCAL_TIMEOUT = 10_000;
/** Commits run hooks, which may take a while. */
const COMMIT_TIMEOUT = 5 * 60_000;
const NETWORK_TIMEOUT = 5 * 60_000;
const LOCK_RETRY_MS = 500;
const MAX_OUTPUT = 20_000;
const MAX_PATHS = 10_000;

// ---------- the queue ----------

const queues = new Map<string, Promise<unknown>>();
const networkCommands = new Map<string, AbortController>();
const repoKey = (top: string) => process.platform === 'win32' ? top.toLowerCase() : top;

/** Runs `fn` after every earlier write on the same repository has finished. */
function serialised<T>(top: string, fn: () => Promise<T>): Promise<T> {
  const key = repoKey(top);
  const next = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return next;
}

// ---------- running and explaining ----------

const BUSY = 'Git is busy in this repository: another git command is running';

/** git's output as one sentence a person can act on, for the failures we know; null for others. */
export function knownError(output: string): string | null {
  if (/could not read Username|Authentication failed|terminal prompts disabled|Permission denied \(publickey\)|could not read Password|fatal: Authentication/i.test(output)) return 'Git needs credentials for origin. Sign in once from a terminal (git fetch) and try again.';
  if (/non-fast-forward|fetch first|remote contains work that you do not have locally/i.test(output)) return 'The remote has new commits';
  if (/index\.lock/.test(output)) return BUSY;
  if (/Please tell me who you are|Author identity unknown|unable to auto-detect email|empty ident name/i.test(output)) {
    return 'Git doesn\'t know who you are. Set your name and email once in a terminal: git config --global user.name "Your Name" and git config --global user.email you@example.com';
  }
  if (/nothing to commit|no changes added to commit|nothing added to commit/.test(output)) return 'Nothing to commit';
  if (/unmerged files|Committing is not possible|resolve your current index first|needs merge|is unmerged/i.test(output)) return 'Resolve the conflicts first';
  if (/patch does not apply|while searching for|corrupt patch|patch failed/.test(output)) {
    return "The change doesn't apply cleanly any more. Refresh the diff and try again";
  }
  if (/paths are ignored by one of your \.gitignore/.test(output)) return 'That path is ignored (.gitignore), so git leaves it out';
  if (/gpg failed to sign|failed to sign the data|signing failed/i.test(output)) return 'Signing the commit failed';
  return null;
}

/** `knownError`, else git's own first error line. */
export function explain(output: string): string {
  const known = knownError(output);
  if (known) return known;
  const line = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^(fatal|error):/.test(l));
  return line ? line.replace(/^(fatal|error):\s*/, '') : 'Git failed';
}

const quoteArg = (a: string) => (/^[\w@%+=:,./^~-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

class WriteRun {
  readonly commands: GitCommand[] = [];
  constructor(readonly repo: RepoInfo) {}

  get top(): string {
    return this.repo.top;
  }

  /** Runs git in the repository's top, recording it. Retries once after 500 ms when `index.lock` is held. */
  async run(args: string[], opts: GitOptions = {}): Promise<GitResult> {
    let res = await this.once(args, opts);
    if (res.code !== 0 && /index\.lock/.test(res.stderr)) {
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
      res = await this.once(args, opts);
    }
    return res;
  }

  /** `run`, throwing a GitError (409, with `explain`'s sentence unless `message` gives one) when git fails. */
  async must(args: string[], opts: GitOptions = {}, message?: (output: string) => string | undefined): Promise<GitResult> {
    const res = await this.run(args, opts);
    if (res.code !== 0) {
      const output = outputOf(res);
      throw new GitError(409, message?.(output) ?? explain(output), output.trim());
    }
    return res;
  }

  private async once(args: string[], opts: GitOptions): Promise<GitResult> {
    const command = ['git', ...args].map(quoteArg).join(' ');
    let res: GitResult;
    try {
      res = await git(this.top, args, { timeout: LOCAL_TIMEOUT, ...opts, write: true, env: { GIT_TERMINAL_PROMPT: '0', ...opts.env } });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.commands.push({ command, code: -1, output: why });
      throw new GitError(500, /timed out/.test(why) ? 'Git took too long and was stopped' : `Git couldn't run: ${why}`, why);
    }
    this.commands.push({ command, code: res.code, output: outputOf(res).slice(0, MAX_OUTPUT) });
    return res;
  }
}

/** Stops only the network command currently running for this repository; queued writes remain queued. */
export async function cancelNetwork(root: string): Promise<{ cancelled: boolean }> {
  const repo = await needRepo(root);
  const controller = networkCommands.get(repoKey(repo.top));
  if (controller) controller.abort();
  return { cancelled: !!controller };
}

type RemoteAction = 'fetch' | 'pull' | 'push' | 'sync' | 'publish';

/** Network git command with a per-repository cancellation handle. */
async function network(run: WriteRun, args: string[], allowFailure = false): Promise<GitResult> {
  const key = repoKey(run.top);
  const controller = new AbortController();
  networkCommands.set(key, controller);
  try {
    const res = await run.run(args, { timeout: NETWORK_TIMEOUT, signal: controller.signal });
    if (controller.signal.aborted) throw new GitError(409, 'Git command cancelled', outputOf(res));
    if (res.code !== 0 && !allowFailure) throw new GitError(409, explain(outputOf(res)), outputOf(res));
    return res;
  } finally {
    if (networkCommands.get(key) === controller) networkCommands.delete(key);
  }
}

/** Fetch, pull, push, sync or publish a branch, using the same write queue as local actions. */
export function remoteAction(root: string, action: RemoteAction, gitPull: 'merge' | 'rebase', remote?: string): Promise<WriteResult & { pulled: number; pushed: number; conflicted: boolean }> {
  return write(root, async (run) => {
    let status = await gitStatus(root, true);
    if (!status) throw new GitError(400, 'This folder is not a Git repository');
    if (action !== 'fetch' && (!status?.branch || !status.head)) throw new GitError(409, 'Create a branch and commit before using the remote');
    let pulled = 0;
    let pushed = 0;
    let conflicted = false;
    const upstream = status.upstream;
    const remoteName = upstream?.split('/')[0] ?? 'origin';
    if (action === 'publish') {
      if (upstream) throw new GitError(409, `This branch already tracks ${upstream}`);
      const names = (await run.must(['remote'])).stdout.toString('utf8').split(/\r?\n/).filter(Boolean);
      if (!names.length) throw new GitError(409, 'Add a remote before publishing this branch');
      if (remote && !names.includes(remote)) throw new GitError(400, `Remote ${remote} does not exist`);
      if (names.length > 1 && !remote) throw new GitError(400, 'Choose a remote to publish this branch');
      await network(run, ['push', '-u', remote ?? names[0], status.branch!]);
      pushed = 1;
    } else {
      if (!upstream && action !== 'fetch') throw new GitError(409, 'Publish this branch before syncing');
      if (action === 'fetch' || action === 'sync') {
        await network(run, ['fetch', upstream ? remoteName : '--all']);
        status = await gitStatus(root, true);
      }
      if ((action === 'pull' || action === 'sync') && (action === 'pull' || (status?.behind ?? 0) > 0)) {
        pulled = status?.behind ?? 0;
        const res = await network(run, ['pull', gitPull === 'rebase' ? '--rebase' : '--no-rebase', '--autostash'], true);
        if (res.code !== 0) {
          const after = await gitStatus(root, true);
          if (after?.conflicts.length || after?.outside.conflicts.length) conflicted = true;
          else throw new GitError(409, explain(outputOf(res)), outputOf(res));
        }
        status = await gitStatus(root, true);
      }
      if (!conflicted && (action === 'push' || action === 'sync') && (action === 'push' || (status?.ahead ?? 0) > 0)) {
        pushed = status?.ahead ?? 0;
        await network(run, ['push']);
      }
    }
    return { pulled, pushed, conflicted };
  });
}

function outputOf(res: GitResult): string {
  return [res.stdout.toString('utf8').trim(), res.stderr.trim()].filter(Boolean).join('\n');
}

/**
 * Runs a write on the repository holding `root`: queued per repository, then the fresh status.
 * Errors carry the commands that ran; `gitEvents` hears of every write that ran one.
 */
async function write<T extends object>(root: string, action: (run: WriteRun) => Promise<T>): Promise<T & WriteResult> {
  const repo = await needRepo(root);
  return serialised(repo.top, async () => {
    const run = new WriteRun(repo);
    try {
      const result = await action(run);
      forgetGitCaches();
      return { ...result, status: await gitStatus(root, true), commands: run.commands };
    } catch (err) {
      if (err instanceof GitError) err.commands = run.commands;
      else if (err instanceof FileError) throw Object.assign(new GitError(err.status, err.message), { commands: run.commands });
      throw err;
    } finally {
      if (run.commands.length) {
        forgetGitCaches();
        gitEvents.emit('write', { top: repo.top });
      }
    }
  });
}

// ---------- paths ----------

/** Repo-relative paths from the request: relative, no "..", deduplicated. */
function repoPaths(paths: string[]): string[] {
  if (paths.length === 0) throw new FileError(400, '"paths" is empty');
  if (paths.length > MAX_PATHS) throw new FileError(400, `At most ${MAX_PATHS} paths at once`);
  const out = paths.map((p) => {
    const parts = relParts(p);
    if (parts.length === 0) throw new FileError(400, 'A path is empty');
    if (parts[0].toLowerCase() === '.git') throw new FileError(400, "Paths in .git can't be changed");
    return parts.join('/');
  });
  return [...new Set(out)];
}

/** Every group of the status, inside and outside the root. */
function allGroups(status: GitStatus): { conflicts: GitEntry[]; staged: GitEntry[]; unstaged: GitEntry[] } {
  return {
    conflicts: [...status.conflicts, ...status.outside.conflicts],
    staged: [...status.staged, ...status.outside.staged],
    unstaged: [...status.unstaged, ...status.outside.unstaged],
  };
}

/** Pathspecs go through stdin (no command-line length limit), taken literally. */
const pathspecArgs = ['--pathspec-from-file=-', '--pathspec-file-nul'];
const pathInput = (paths: string[]) => paths.join('\0') + '\0';

async function freshStatus(root: string): Promise<GitStatus> {
  forgetGitCaches();
  const status = await gitStatus(root, true);
  if (!status) throw new FileError(400, 'Not a git repository');
  return status;
}

const MARKERS = /^(<{7}|>{7})( |$)/m;

/** A conflicted file may be staged (marked resolved) only once its conflict markers are gone. */
async function checkResolved(top: string, p: string): Promise<void> {
  const full = await resolveInside(top, p, false);
  const text = await readFile(full, 'utf8').catch(() => null);
  if (text !== null && MARKERS.test(text)) throw new GitError(409, `${p} still has conflict markers`);
}

// ---------- stage, unstage, discard ----------

/** `git add` the paths (changes, new files and deletions). A conflicted file is marked resolved, once it has no markers. */
export function stagePaths(root: string, paths: string[]): Promise<WriteResult> {
  const list = repoPaths(paths);
  return write(root, async (run) => {
    const status = await freshStatus(root);
    for (const c of allGroups(status).conflicts) if (list.includes(c.path)) await checkResolved(run.top, c.path);
    await run.must(['--literal-pathspecs', 'add', '-A', ...pathspecArgs], { input: pathInput(list) });
    return {};
  });
}

/** Takes the paths out of the index (back to HEAD's version; the working tree is untouched). A staged rename takes its old path along. */
export function unstagePaths(root: string, paths: string[]): Promise<WriteResult> {
  const list = repoPaths(paths);
  return write(root, async (run) => {
    const status = await freshStatus(root);
    const groups = allGroups(status);
    const conflict = groups.conflicts.find((c) => list.includes(c.path));
    if (conflict) throw new GitError(409, `${conflict.path} has a conflict. Resolve it instead of unstaging`);
    const all = new Set(list);
    for (const e of groups.staged) if (e.oldPath && all.has(e.path)) all.add(e.oldPath);
    // `reset -- paths` also works on a branch without commits, unlike `restore --staged`.
    await run.must(['--literal-pathspecs', 'reset', '-q', ...pathspecArgs], { input: pathInput([...all]) });
    return {};
  });
}

/**
 * Throws away unstaged changes: a tracked file gets its index version back (`restore --worktree`, so staged work
 * stays); an untracked file is deleted. Every path must have unstaged changes.
 */
export function discardPaths(root: string, paths: string[]): Promise<WriteResult & { deleted: string[] }> {
  const list = repoPaths(paths);
  return write(root, async (run) => {
    const status = await freshStatus(root);
    const groups = allGroups(status);
    const tracked: string[] = [];
    const untracked: string[] = [];
    for (const p of list) {
      if (groups.conflicts.some((c) => c.path === p)) throw new GitError(409, `${p} has a conflict. Resolve it first`);
      const entry = groups.unstaged.find((e) => e.path === p);
      if (!entry) throw new GitError(409, `${p} has no unstaged changes to discard`);
      (entry.status === 'U' ? untracked : tracked).push(p);
    }
    // Check every untracked file before deleting any.
    const fulls = await Promise.all(untracked.map((p) => resolveInside(run.top, p)));
    if (tracked.length) await run.must(['--literal-pathspecs', 'restore', '--worktree', ...pathspecArgs], { input: pathInput(tracked) });
    for (const full of fulls) {
      if (!(await stat(full)).isFile()) throw new GitError(409, `${toPosix(path.relative(run.top, full))} isn't a file`);
      await rm(full);
    }
    if (untracked.length) run.commands.push({ command: `delete ${untracked.map(quoteArg).join(' ')}`, code: 0, output: '' });
    return { deleted: untracked };
  });
}

// ---------- partial patches ----------

export type ApplyAction = 'stage' | 'unstage' | 'discard';
export const APPLY_ACTIONS: ApplyAction[] = ['stage', 'unstage', 'discard'];

export type PartialPatch = {
  /** The selected hunks, headers recounted; empty when nothing is selected. */
  hunks: string;
  /** Change lines (`+` / `-`) selected, and in the whole diff. */
  selected: number;
  total: number;
};

/**
 * The part of `diff` (hunks only, as the diff route gives them) that `hunks` (hunk indexes) and `lines`
 * (indexes into `diff.split('\n')`) select, following `git add -p`: an unselected `+` is dropped and an
 * unselected `−` becomes context. `reverse` (for `git apply -R`) swaps the two, since the patch then
 * applies to the new side.
 */
export function partialPatch(diff: string, hunks: Set<number>, lines: Set<number>, reverse: boolean): PartialPatch {
  const all = diff.split('\n');
  if (all.length && all[all.length - 1] === '') all.pop();
  const out: string[] = [];
  let selected = 0;
  let total = 0;
  let offset = 0; // new minus old lines of the hunks written so far
  let hunk = -1;
  let i = 0;
  while (i < all.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(all[i]);
    if (!header) {
      i++;
      continue;
    }
    hunk++;
    const body: string[] = [];
    let oldN = 0;
    let newN = 0;
    let changed = false;
    let kept = false; // whether the previous line made it into the patch, for "\ No newline" markers
    for (i++; i < all.length && !all[i].startsWith('@@'); i++) {
      const line = all[i];
      const c = line[0];
      if (c === '\\') {
        if (kept) body.push(line);
        continue;
      }
      if (c !== '+' && c !== '-') {
        body.push(c === ' ' ? line : ` ${line}`);
        oldN++;
        newN++;
        kept = true;
        continue;
      }
      total++;
      const sel = hunks.has(hunk) || lines.has(i);
      if (sel) {
        selected++;
        changed = true;
        body.push(line);
        if (c === '-') oldN++;
        else newN++;
        kept = true;
      } else if ((c === '-') !== reverse) {
        // Forward: an unselected removal stays as context. Reverse: an unselected addition does.
        body.push(` ${line.slice(1)}`);
        oldN++;
        newN++;
        kept = true;
      } else {
        kept = false;
      }
    }
    if (!changed) continue;
    const [oldStart, oldCount, newStart, newCount] = [1, 2, 3, 4].map((k) => (header[k] === undefined ? 1 : Number(header[k])));
    let os: number;
    let ns: number;
    if (!reverse) {
      // The old side is the one the patch applies to: its numbers stay.
      const oldPos = oldCount ? oldStart : oldStart + 1;
      const newPos = oldPos + offset;
      [os, ns] = [oldStart, newN ? newPos : newPos - 1];
    } else {
      const newPos = newCount ? newStart : newStart + 1;
      const oldPos = newPos - offset;
      [os, ns] = [oldN ? oldPos : oldPos - 1, newStart];
    }
    offset += newN - oldN;
    out.push(`@@ -${os},${oldN} +${ns},${newN} @@${header[5]}`, ...body);
  }
  return { hunks: out.length ? out.join('\n') + '\n' : '', selected, total };
}

/** A path as git writes it in patch headers: C-quoted when it has quotes, backslashes or control characters. */
function patchPath(prefix: string, p: string): string {
  const full = prefix + p;
  if (!/["\\\x00-\x1f\x7f]/.test(full)) return full;
  const escaped = full.replace(/[\\"]/g, (c) => `\\${c}`).replace(/[\x00-\x1f\x7f]/g, (c) => {
    const named: Record<string, string> = { '\n': '\\n', '\t': '\\t', '\r': '\\r' };
    return named[c] ?? `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`;
  });
  return `"${escaped}"`;
}

export type ApplyRequest = {
  /** Relative to the root, like the diff route. */
  path: string;
  side: 'worktree' | 'staged';
  hunks: number[];
  lines: number[];
  hash: string;
  action: ApplyAction;
  context?: number;
};

/**
 * Stages, unstages or discards part of a file's diff. The diff is rebuilt here and must still have the hash the
 * UI saw (409 otherwise: the file changed since). A selection of every change falls back to the whole file.
 */
export function applyPartial(root: string, req: ApplyRequest): Promise<WriteResult & { whole: boolean }> {
  const wanted = req.action === 'unstage' ? 'staged' : 'worktree';
  if (req.side !== wanted) throw new FileError(400, `To ${req.action}, use the ${wanted === 'staged' ? 'staged' : 'working tree'} diff (side=${wanted})`);
  return write(root, async (run) => {
    const full = await resolveInside(root, req.path, false);
    const rel = toPosix(path.relative(root, full));
    const repoPath = run.repo.prefix + rel;
    forgetGitCaches();
    const diff = await fileDiff(root, rel, { side: req.side, context: req.context });
    if (diff.hash !== req.hash) throw new GitError(409, 'The file changed since you looked at it. Look at the new diff and try again');
    if (diff.status === 'C') throw new GitError(409, `${repoPath} has a conflict. Resolve it first`);
    if (diff.binary || diff.truncated) throw new GitError(400, `${repoPath} can only be ${done(req.action)} as a whole file`);
    const reverse = req.action !== 'stage';
    const patch = partialPatch(diff.diff, new Set(req.hunks), new Set(req.lines), reverse);
    if (patch.selected === 0) throw new GitError(400, 'Nothing is selected');

    if (patch.selected === patch.total) {
      // Everything: the whole-file action, which also handles new, deleted and renamed files.
      if (req.action === 'stage') await run.must(['--literal-pathspecs', 'add', '-A', '--', repoPath]);
      else if (req.action === 'unstage') {
        const status = await freshStatus(root);
        const oldPath = allGroups(status).staged.find((e) => e.path === repoPath)?.oldPath;
        await run.must(['--literal-pathspecs', 'reset', '-q', '--', repoPath, ...(oldPath ? [oldPath] : [])]);
      } else if (diff.status === 'U') {
        await rm(await resolveInside(run.top, repoPath));
        run.commands.push({ command: `delete ${quoteArg(repoPath)}`, code: 0, output: '' });
      } else await run.must(['--literal-pathspecs', 'restore', '--worktree', '--', repoPath]);
      return { whole: true };
    }

    if (diff.status === 'R') throw new GitError(400, `${repoPath} was renamed, so it can only be ${done(req.action)} as a whole file`);
    if (diff.status === 'D' && reverse) throw new GitError(400, `${repoPath} was deleted, so it can only be ${done(req.action)} as a whole file`);

    let hunks = patch.hunks;
    let header: string;
    const a = patchPath('a/', repoPath);
    const b = patchPath('b/', repoPath);
    if (diff.status === 'U' && !reverse) {
      // Part of an untracked file: a new file in the index with only the selected lines.
      header = `diff --git ${a} ${b}\nnew file mode 100644\n--- /dev/null\n+++ ${b}\n`;
      // The diff route's untracked diff has no "\ No newline" marker: add it when the file's last line is in.
      const text = await readFile(await resolveInside(run.top, repoPath), 'utf8').catch(() => '');
      const lastIndex = diff.diff.split('\n').length - 1;
      if (text && !text.endsWith('\n') && (req.hunks.includes(0) || req.lines.includes(lastIndex))) hunks += '\\ No newline at end of file\n';
    } else {
      header = `diff --git ${a} ${b}\n--- ${a}\n+++ ${b}\n`;
    }
    const args = ['apply', '--whitespace=nowarn'];
    if (req.action !== 'discard') args.push('--cached');
    if (reverse) args.push('-R');
    if (req.context === 0) args.push('--unidiff-zero');
    args.push('-');
    await run.must(args, { input: header + hunks });
    return { whole: false };
  });
}

const done = (action: ApplyAction) => ({ stage: 'staged', unstage: 'unstaged', discard: 'discarded' })[action];

// ---------- commit ----------

/** Whether HEAD is on a remote-tracking branch, so rewriting it would need a force push. */
async function headPushed(run: WriteRun): Promise<boolean> {
  const res = await run.must(['for-each-ref', '--contains', 'HEAD', '--count=1', '--format=%(refname)', 'refs/remotes']);
  return res.stdout.toString('utf8').trim() !== '';
}

/** The commit hooks this repository has (core.hooksPath respected). */
async function commitHooks(run: WriteRun): Promise<string[]> {
  const names = ['pre-commit', 'prepare-commit-msg', 'commit-msg'];
  const res = await run.run(['rev-parse', ...names.flatMap((n) => ['--git-path', `hooks/${n}`])]);
  if (res.code !== 0) return [];
  const paths = res.stdout.toString('utf8').split(/\r?\n/).slice(0, names.length);
  const found = await Promise.all(paths.map((p) => stat(path.resolve(run.top, p)).then((s) => s.isFile(), () => false)));
  return names.filter((_, i) => found[i]);
}

export type CommitRequest = { message: string; amend?: boolean; all?: boolean };

/**
 * Commits what is staged (`all`: everything, after `git add -A` on the whole repository). Hooks run; a failing one
 * says so. Amend is refused when HEAD is already pushed.
 */
export function commit(root: string, req: CommitRequest): Promise<WriteResult & { hash: string }> {
  if (!req.message.trim()) throw new FileError(400, 'Write a message');
  return write(root, async (run) => {
    const status = await freshStatus(root);
    if (req.amend) {
      if (!status.head) throw new GitError(409, 'There is no commit to amend yet');
      if (await headPushed(run)) throw new GitError(409, 'Already pushed: amending would need a force push');
    }
    const conflicts = allGroups(status).conflicts.length;
    if (conflicts) throw new GitError(409, `Resolve ${conflicts === 1 ? 'the conflict' : `${conflicts} conflicts`} first`);
    if (req.all) await run.must(['add', '-A']);
    if (!req.amend && status.operation?.kind !== 'merge') {
      const staged = await run.run(['diff', '--cached', '--quiet']);
      if (staged.code === 0) throw new GitError(409, req.all ? 'Nothing to commit: the working tree is clean' : 'Nothing is staged to commit');
    }
    const hooks = await commitHooks(run);
    await run.must(
      ['commit', '-F', '-', ...(req.amend ? ['--amend'] : [])],
      { input: req.message, timeout: COMMIT_TIMEOUT },
      (output) => knownError(output) ?? (hooks.length ? `The ${hooks.join(' or ')} hook refused the commit` : undefined),
    );
    const head = await run.must(['rev-parse', 'HEAD']);
    return { hash: head.stdout.toString('utf8').trim() };
  });
}

/**
 * Undoes the last commit with `reset --soft HEAD~1`: its changes stay staged and its message comes back.
 * Only for a commit that isn't pushed, isn't a merge and isn't the first; `hash`, when given, must still be HEAD.
 */
export function undoCommit(root: string, hash?: string): Promise<WriteResult & { undone: string; message: string }> {
  return write(root, async (run) => {
    const status = await freshStatus(root);
    if (!status.head) throw new GitError(409, 'There is no commit to undo');
    if (hash && !status.head.startsWith(hash)) throw new GitError(409, 'The last commit changed since you looked. Look again and try once more');
    if (status.operation) throw new GitError(409, `Finish or abort the ${status.operation.kind} first`);
    const parents = (await run.must(['rev-list', '--parents', '-n', '1', 'HEAD'])).stdout.toString('utf8').trim().split(/\s+/).length - 1;
    if (parents === 0) throw new GitError(409, "This is the repository's first commit, so it can't be undone here");
    if (parents > 1) throw new GitError(409, "A merge commit can't be undone here");
    if (await headPushed(run)) throw new GitError(409, 'Already pushed: undoing it would need a force push');
    const message = (await run.must(['log', '-1', '--format=%B', 'HEAD'])).stdout.toString('utf8').replace(/\s+$/, '');
    await run.must(['reset', '--soft', 'HEAD~1']);
    return { undone: status.head, message };
  });
}
