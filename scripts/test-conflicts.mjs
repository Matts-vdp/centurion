// Step 8 integration against a separate manager and local bare origins.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolverRegions } from '../ui/src/resolverModel.ts';

const project = path.resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(path.join(project, '.conflict-test-'));
const port = 48000 + Math.floor(Math.random() * 10000);
const token = 'conflict-integration-test';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const attempt = (cwd, ...args) => { try { git(cwd, ...args); } catch { /* conflict is expected */ } };
const put = (repo, name, value) => writeFileSync(path.join(repo, name), value);
const commit = (repo, message) => { git(repo, 'add', '-A'); git(repo, 'commit', '-m', message); };
const repo = (name, base = 'base\n') => {
  const bare = path.join(scratch, `${name}.git`), work = path.join(scratch, name);
  mkdirSync(bare); mkdirSync(work);
  git(bare, 'init', '--bare', '--initial-branch=main');
  git(work, 'init', '-b', 'main');
  git(work, 'config', 'core.autocrlf', 'false');
  git(work, 'config', 'user.name', 'Conflict Test'); git(work, 'config', 'user.email', 'conflict@test.invalid');
  put(work, 'a.txt', base); commit(work, 'base');
  git(work, 'remote', 'add', 'origin', bare); git(work, 'push', '-u', 'origin', 'main');
  return { work, bare };
};
const names = ['merge', 'rebase', 'stash', 'delete', 'binary', 'multi', 'simple'];
const repos = Object.fromEntries(names.map((n) => [n, repo(n, n === 'multi' ? Array.from({ length: 2000 }, (_, i) => `line ${i}\n`).join('') : 'base\n')]));
const config = path.join(scratch, 'config.json');
writeFileSync(config, JSON.stringify({ port, token, stateFile: path.join(scratch, 'state', 'state.json'), orchestratorFolder: repos.merge.work, removeEnv: Object.keys(process.env).filter((k) => /^CLAUDE|^ANTHROPIC_/i.test(k)) }));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE|^ANTHROPIC_/i.test(k)));
const manager = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'start', '--config', config], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let passed = false, output = '';
manager.stdout.on('data', (b) => output += b); manager.stderr.on('data', (b) => output += b);
const request = async (url, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${data.error}: ${data.details ?? ''}`), { status: res.status, data });
  return data;
};
try {
  let ready = false;
  for (let i = 0; i < 80; i++) { try { await request('/api/info'); ready = true; break; } catch { await delay(100); } }
  assert(ready, `Manager did not start: ${output}`);
  const parent = await request('/api/agents', { name: 'Scratch' });
  const ids = { merge: parent.id };
  for (const name of names.slice(1)) ids[name] = (await request(`/api/agents/${parent.id}/experts`, { name, cwd: repos[name].work })).id;
  const conflict = (name) => request(`/api/agents/${ids[name]}/git/conflict?path=a.txt`);
  const resolve = (name, body) => request(`/api/agents/${ids[name]}/git/resolve`, { path: 'a.txt', ...body });
  const status = (name) => request(`/api/agents/${ids[name]}/git/status`);

  // Merge: stage 2 is the feature; stage 3 is main.
  let w = repos.merge.work;
  git(w, 'switch', '-c', 'feature'); put(w, 'a.txt', 'feature\n'); commit(w, 'feature');
  git(w, 'switch', 'main'); put(w, 'a.txt', 'main\n'); commit(w, 'main'); git(w, 'switch', 'feature'); attempt(w, 'merge', 'main');
  let d = await conflict('merge'); assert.match(d.labels.yours, /feature/); assert.match(d.labels.incoming, /main/);
  assert.equal(d.blocks.length, 1); assert.equal(d.blocks[0].yours, 'feature\n'); assert.equal(d.blocks[0].incoming, 'main\n');
  assert.equal(d.merged.slice(d.blocks[0].start, d.blocks[0].end).startsWith('<<<<<<<'), true);
  await resolve('merge', { take: 'incoming', hash: d.hash }); assert.equal(readFileSync(path.join(w, 'a.txt'), 'utf8'), 'main\n');
  assert.equal((await status('merge')).status.conflicts.length, 0);

  // Rebase: stage 3 is the replayed feature commit, stage 2 is main.
  w = repos.rebase.work; git(w, 'switch', '-c', 'feature'); put(w, 'a.txt', 'feature\n'); commit(w, 'feature');
  git(w, 'switch', 'main'); put(w, 'a.txt', 'main\n'); commit(w, 'main'); git(w, 'switch', 'feature'); attempt(w, 'rebase', 'main');
  d = await conflict('rebase'); assert.match(d.labels.yours, /commit being replayed from feature/); assert.match(d.labels.yours, new RegExp(git(w, 'rev-parse', '--short=7', 'REBASE_HEAD'))); assert.match(d.labels.incoming, /main/);
  assert.equal(d.blocks[0].yours, 'feature\n'); assert.equal(d.blocks[0].incoming, 'main\n');
  await resolve('rebase', { take: 'yours', hash: d.hash }); assert.equal(readFileSync(path.join(w, 'a.txt'), 'utf8'), 'feature\n');

  // Stash pop has no operation file; its retained stash identifies the local side.
  w = repos.stash.work; put(w, 'a.txt', 'stashed\n'); git(w, 'stash', 'push', '-m', 'local');
  put(w, 'a.txt', 'branch\n'); commit(w, 'branch'); attempt(w, 'stash', 'pop');
  d = await conflict('stash'); assert.match(d.labels.yours, /Stashed changes/); assert.equal(d.blocks[0].yours, 'stashed\n');
  await resolve('stash', { take: 'yours' }); assert.equal(readFileSync(path.join(w, 'a.txt'), 'utf8'), 'stashed\n');

  // Delete/modify and binary are whole-file choices.
  w = repos.delete.work; put(w, 'b.txt', 'base\n'); commit(w, 'second file');
  git(w, 'switch', '-c', 'feature'); git(w, 'rm', 'a.txt', 'b.txt'); commit(w, 'delete');
  git(w, 'switch', 'main'); put(w, 'a.txt', 'modified\n'); put(w, 'b.txt', 'modified\n'); commit(w, 'modify'); git(w, 'switch', 'feature'); attempt(w, 'merge', 'main');
  d = await conflict('delete'); assert.equal(d.deleted, 'yours'); assert.equal(d.blocks.length, 0);
  await resolve('delete', { take: 'incoming' }); assert.equal(readFileSync(path.join(w, 'a.txt'), 'utf8'), 'modified\n');
  await request(`/api/agents/${ids.delete}/git/resolve`, { path: 'b.txt', take: 'delete' }); assert.equal(existsSync(path.join(w, 'b.txt')), false);
  w = repos.binary.work; put(w, 'a.bin', Buffer.from([0, 1, 2])); commit(w, 'binary base');
  git(w, 'switch', '-c', 'feature'); put(w, 'a.bin', Buffer.from([0, 3, 4])); commit(w, 'binary feature');
  git(w, 'switch', 'main'); put(w, 'a.bin', Buffer.from([0, 5, 6])); commit(w, 'binary main'); git(w, 'switch', 'feature'); attempt(w, 'merge', 'main');
  d = await request(`/api/agents/${ids.binary}/git/conflict?path=a.bin`); assert.equal(d.binary, true); assert.equal(d.blocks.length, 0);
  await request(`/api/agents/${ids.binary}/git/resolve`, { path: 'a.bin', take: 'incoming' }); assert.deepEqual([...readFileSync(path.join(w, 'a.bin'))], [0, 5, 6]);

  // Two independent blocks; unchanged text is retained around replacements.
  w = repos.multi.work; const lines = (name) => Array.from({ length: 2000 }, (_, i) => i === 2 || i === 1900 ? `${name} ${i}\n` : i === 800 && name === 'main' ? 'main nonconflicting\n' : i === 1000 && name === 'feature' ? 'feature nonconflicting\n' : `line ${i}\n`).join('');
  git(w, 'config', 'merge.conflictStyle', 'zdiff3');
  git(w, 'switch', '-c', 'feature'); put(w, 'a.txt', lines('feature')); commit(w, 'feature');
  git(w, 'switch', 'main'); put(w, 'a.txt', lines('main')); commit(w, 'main'); git(w, 'switch', 'feature'); attempt(w, 'merge', 'main');
  d = await conflict('multi'); assert.equal(d.blocks.length, 2);
  const regions = resolverRegions(d);
  assert.equal(regions.filter((r) => r.conflict).length, 2);
  assert.equal(regions.filter((r) => r.changed && !r.conflict).length, 2);
  let unmarked = d.merged; for (let i = d.blocks.length - 1; i >= 0; i--) unmarked = unmarked.slice(0, d.blocks[i].start) + unmarked.slice(d.blocks[i].end);
  assert.equal(regions.map((r) => r.conflict ? '' : r.initial).join(''), unmarked);
  if (process.env.RESOLVER_BROWSER_UI === '1') {
    console.log(`Resolver browser fixture: http://127.0.0.1:${port}/?token=${token}`);
    console.log(`Scratch folder: ${scratch}`);
    await new Promise((resolve) => process.once('SIGINT', resolve));
  }
  let result = d.merged; for (let i = d.blocks.length - 1; i >= 0; i--) result = result.slice(0, d.blocks[i].start) + d.blocks[i].yours + result.slice(d.blocks[i].end);
  await resolve('multi', { content: result, hash: d.hash }); assert.equal(readFileSync(path.join(w, 'a.txt'), 'utf8'), lines('feature').replace('line 800\n', 'main nonconflicting\n'));

  // Whitespace-only conflict qualifies for the group action.
  w = repos.simple.work; git(w, 'switch', '-c', 'feature'); put(w, 'a.txt', 'same word\n'); commit(w, 'feature');
  git(w, 'switch', 'main'); put(w, 'a.txt', 'same  word\n'); commit(w, 'main'); git(w, 'switch', 'feature'); attempt(w, 'merge', 'main');
  d = await conflict('simple'); assert.equal(d.blocks.length, 1);
  const simple = await request(`/api/agents/${ids.simple}/git/resolve-simple`, { paths: ['a.txt'] }); assert.equal(simple.resolved, 1);
  assert.equal(simple.status.conflicts.length, 0);
  passed = true; console.log('Conflict integration passed');
} finally {
  const closed = new Promise((resolve) => manager.once('close', resolve));
  manager.kill();
  await Promise.race([closed, delay(3000)]);
  if (manager.exitCode === null && manager.signalCode === null) { manager.kill('SIGKILL'); await Promise.race([closed, delay(3000)]); }
  if (passed && path.resolve(scratch).startsWith(project + path.sep) && path.basename(scratch).startsWith('.conflict-test-')) rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
