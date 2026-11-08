import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { FileError, isBinary, MAX_TEXT, resolveInside, toPosix } from './confine.js';
import { git, gitStatus, needRepo } from './git.js';

export type ConflictBlock = { start: number; end: number; base: string; yours: string; incoming: string };
export type Conflict = {
  path: string; code: string; binary: boolean; deleted: 'yours' | 'incoming' | null;
  yoursStage: 2 | 3;
  base: string | null; yours: string | null; incoming: string | null;
  labels: { yours: string; incoming: string; base: string }; merged: string | null;
  hash: string; blocks: ConflictBlock[];
};

/** Locate marker spans only. Their side text is never used as a source of truth. */
function markerSpans(text: string): { start: number; end: number; base: string; yours: string; incoming: string }[] {
  const lines = [...text.matchAll(/[^\n]*(?:\n|$)/g)].filter((m) => m[0]);
  const result: ConflictBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^<{7}(?: |\r?$)/.test(lines[i][0])) continue;
    const start = lines[i].index ?? 0;
    let middle = -1, divider = -1, end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (middle < 0 && /^\|{7}(?: |\r?$)/.test(lines[j][0])) middle = j;
      else if (/^={7}\r?\n?$/.test(lines[j][0])) divider = j;
      else if (/^>{7}(?: |\r?$)/.test(lines[j][0])) { end = j; break; }
    }
    if (divider < 0 || end < 0) continue;
    const body = (a: number, b: number) => lines.slice(a, b).map((l) => l[0]).join('');
    result.push({ start, end: (lines[end].index ?? 0) + lines[end][0].length,
      yours: body(i + 1, middle < 0 ? divider : middle), base: middle < 0 ? '' : body(middle + 1, divider), incoming: body(divider + 1, end) });
    i = end;
  }
  return result;
}

export async function conflictFile(root: string, rel: string): Promise<Conflict> {
  const repo = await needRepo(root);
  const full = await resolveInside(root, rel, false);
  const repoPath = repo.prefix + toPosix(path.relative(root, full));
  const status = await gitStatus(root, true);
  const entry = [...(status?.conflicts ?? []), ...(status?.outside.conflicts ?? [])].find((e) => e.path === repoPath);
  if (!entry) throw new FileError(409, `${repoPath} is no longer conflicted`);
  const listed = await git(repo.top, ['ls-files', '-u', '-z', '--', repoPath], { env: { GIT_LITERAL_PATHSPECS: '1' } });
  const hashes = new Map<number, string>();
  for (const record of listed.stdout.toString('utf8').split('\0')) {
    const m = /^\d+ ([a-f0-9]+) ([123])\t/.exec(record);
    if (m) hashes.set(Number(m[2]), m[1]);
  }
  const load = async (stage: number): Promise<Buffer | null> => {
    const hash = hashes.get(stage);
    if (!hash) return null;
    const r = await git(repo.top, ['cat-file', 'blob', hash]);
    if (r.code !== 0) throw new FileError(409, 'The conflict changed. Refresh it');
    return r.stdout;
  };
  const [baseBuf, second, third] = await Promise.all([load(1), load(2), load(3)]);
  const rebase = status?.operation?.kind === 'rebase';
  const stash = !status?.operation && hashes.has(3) ? await git(repo.top, ['rev-parse', '-q', '--verify', `stash@{0}:${repoPath}`]).then((r) => r.code === 0 && r.stdout.toString('utf8').trim() === hashes.get(3), () => false) : false;
  const flipped = rebase || stash;
  const yoursBuf = flipped ? third : second;
  const incomingBuf = flipped ? second : third;
  const current = status?.operation?.branch ?? status?.branch ?? 'your changes';
  const other = status?.operation?.onto ?? (stash ? current : 'incoming commit');
  const replay = rebase ? await git(repo.top, ['show', '-s', '--format=%h %s', 'REBASE_HEAD']).then((r) => r.code === 0 ? r.stdout.toString('utf8').trim().split('\n')[0] : null, () => null) : null;
  const labels = { yours: `${stash ? 'Stashed changes' : rebase ? `${replay ?? current} · commit being replayed from ${current}` : current} (yours)`, incoming: `${other} (incoming)`, base: 'Base' };
  const binary = [baseBuf, second, third].some((b) => b && isBinary(b));
  const deleted = !yoursBuf ? 'yours' : !incomingBuf ? 'incoming' : null;
  const work = await readFile(full).catch(() => null);
  const merged = work && !binary && work.length <= MAX_TEXT ? work.toString('utf8') : null;
  const hash = createHash('sha256').update(work ?? Buffer.alloc(0)).update([...hashes.values()].join(':')).digest('hex');
  let blocks: ConflictBlock[] = [];
  if (!binary && !deleted && merged !== null && yoursBuf && incomingBuf) {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'centurion-conflict-'));
    try {
      const names = ['yours', 'base', 'incoming'].map((n) => path.join(temp, n));
      await Promise.all([yoursBuf, baseBuf ?? Buffer.alloc(0), incomingBuf].map((b, i) => writeFile(names[i], b)));
      const generated = await git(repo.top, ['merge-file', '-p', '--diff3', '-L', 'yours', '-L', 'base', '-L', 'incoming', ...names]);
      const fromIndex = markerSpans(generated.stdout.toString('utf8'));
      const positions = markerSpans(merged);
      if (fromIndex.length !== positions.length) throw new FileError(409, `Conflict markers changed (${positions.length} in file, ${fromIndex.length} in index). Refresh or resolve the file in an editor`);
      blocks = positions.map((span, i) => ({ start: span.start, end: span.end,
        base: fromIndex[i].base, yours: fromIndex[i].yours, incoming: fromIndex[i].incoming }));
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
  return { path: repoPath, code: entry.code ?? '', binary, deleted, yoursStage: flipped ? 3 : 2, base: baseBuf && !binary ? baseBuf.toString('utf8') : null,
    yours: yoursBuf && !binary ? yoursBuf.toString('utf8') : null,
    incoming: incomingBuf && !binary ? incomingBuf.toString('utf8') : null, labels, merged, hash, blocks };
}
