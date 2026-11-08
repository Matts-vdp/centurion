// Integration exercise for docs/git-plan.md step 6. Uses its own manager, state, port and bare origin.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const project = path.resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(path.join(project, '.branch-test-'));
const port = 48000 + Math.floor(Math.random() * 10000);
const token = 'branch-integration-test';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (repo, file, value) => writeFileSync(path.join(repo, file), value);
const commit = (repo, message) => { git(repo, 'add', '-A'); git(repo, 'commit', '-m', message); };
const repo = (name) => {
  const bare = path.join(scratch, `${name}.git`), work = path.join(scratch, name);
  mkdirSync(bare); mkdirSync(work);
  git(bare, 'init', '--bare', '--initial-branch=main');
  git(work, 'init', '-b', 'main');
  git(work, 'config', 'user.name', 'Branch Test'); git(work, 'config', 'user.email', 'branch@test.invalid');
  put(work, 'a.txt', 'base\n'); commit(work, 'base');
  git(work, 'remote', 'add', 'origin', bare); git(work, 'push', '-u', 'origin', 'main');
  git(work, 'remote', 'set-head', 'origin', '-a');
  return { work, bare };
};

const repos = Object.fromEntries(['switch', 'merge', 'rebase', 'update', 'delete'].map((n) => [n, repo(n)]));
const config = path.join(scratch, 'config.json');
writeFileSync(config, JSON.stringify({ port, token, stateFile: path.join(scratch, 'state', 'state.json'), orchestratorFolder: repos.switch.work, removeEnv: Object.keys(process.env).filter((k) => /^CLAUDE|^ANTHROPIC_/i.test(k)) }));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE|^ANTHROPIC_/i.test(k)));
const manager = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'start', '--config', config], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let passed = false;
let output = '';
manager.stdout.on('data', (b) => output += b);
manager.stderr.on('data', (b) => output += b);
const request = async (url, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${data.error}: ${data.details ?? ''}`), { status: res.status, data });
  return data;
};
const action = (id, name, body = {}) => request(`/api/agents/${id}/git/${name}`, body);
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { await request('/api/info'); ready = true; break; } catch { await delay(100); }
  }
  assert(ready, `Manager did not start: ${output}`);
  const parent = await request('/api/agents', { name: 'Scratch' });
  const ids = { switch: parent.id };
  for (const name of ['merge', 'rebase', 'update', 'delete']) {
    const agent = await request(`/api/agents/${parent.id}/experts`, { name, cwd: repos[name].work });
    ids[name] = agent.id;
  }

  // Switch: Git refuses dirty files, then Centurion stashes, switches and pops. Exercise both pop outcomes.
  const sw = repos.switch.work;
  put(sw, 'a.txt', 'base\nmiddle\nend\n'); commit(sw, 'three lines'); git(sw, 'push');
  await action(ids.switch, 'branch', { name: 'other', from: 'main', switch: true });
  put(sw, 'a.txt', 'other\nmiddle\nend\n'); commit(sw, 'other first line');
  git(sw, 'switch', 'main');
  put(sw, 'a.txt', 'base\nmiddle\nlocal\n');
  let r = await action(ids.switch, 'switch', { branch: 'other' });
  assert.equal(r.stashConflict, false); assert.match(readFileSync(path.join(sw, 'a.txt'), 'utf8'), /local/);
  git(sw, 'restore', 'a.txt'); git(sw, 'switch', 'main');
  put(sw, 'a.txt', 'local change\nmiddle\nend\n');
  r = await action(ids.switch, 'switch', { branch: 'other' });
  assert.equal(r.stashConflict, true); assert.match(git(sw, 'stash', 'list'), /Centurion switch/);
  git(sw, 'restore', '--staged', 'a.txt'); git(sw, 'restore', 'a.txt'); git(sw, 'stash', 'drop');
  git(sw, 'push', '-u', 'origin', 'other'); git(sw, 'switch', 'main'); git(sw, 'branch', '-D', 'other');
  r = await action(ids.switch, 'switch', { branch: 'origin/other' });
  assert.equal(r.status.branch, 'other'); assert.equal(r.status.upstream, 'origin/other');

  // Merge: clean autostash, then conflict with Abort and Continue.
  const mg = repos.merge.work;
  await action(ids.merge, 'branch', { name: 'feature', from: 'main', switch: true });
  put(mg, 'feature.txt', 'feature\n'); commit(mg, 'feature'); git(mg, 'switch', 'main');
  put(mg, 'main.txt', 'main\n'); commit(mg, 'main'); git(mg, 'switch', 'feature');
  put(mg, 'dirty.txt', 'dirty\n');
  r = await action(ids.merge, 'merge', { branch: 'main' });
  assert.equal(r.conflicted, false); assert.equal(readFileSync(path.join(mg, 'dirty.txt'), 'utf8'), 'dirty\n');
  put(mg, 'a.txt', 'feature side\n'); commit(mg, 'feature side'); git(mg, 'switch', 'main');
  put(mg, 'a.txt', 'main side\n'); commit(mg, 'main side'); git(mg, 'switch', 'feature');
  r = await action(ids.merge, 'merge', { branch: 'main' }); assert.equal(r.conflicted, true); assert.equal(r.status.operation.kind, 'merge');
  assert.equal(r.status.operation.startedBy, 'Centurion');
  assert.match((await request(`/api/agents/${ids.merge}/git/merge-message`)).message, /Merge branch 'main'/);
  await action(ids.merge, 'abort'); assert.equal(git(mg, 'status', '--porcelain').includes('UU'), false);
  r = await action(ids.merge, 'merge', { branch: 'main' }); assert.equal(r.conflicted, true);
  put(mg, 'a.txt', 'resolved\n'); await action(ids.merge, 'stage', { paths: ['a.txt'] });
  r = await action(ids.merge, 'continue'); assert.equal(r.status.operation, null);

  // Rebase: allow unpushed commits, refuse once the branch is on origin.
  const rb = repos.rebase.work;
  await action(ids.rebase, 'branch', { name: 'feature', from: 'main', switch: true });
  put(rb, 'feature.txt', 'one\n'); commit(rb, 'feature'); git(rb, 'switch', 'main');
  put(rb, 'main.txt', 'one\n'); commit(rb, 'main'); git(rb, 'switch', 'feature');
  r = await action(ids.rebase, 'rebase', { onto: 'main' }); assert.equal(r.conflicted, false);
  git(rb, 'push', '-u', 'origin', 'feature'); git(rb, 'switch', 'main');
  put(rb, 'next.txt', 'next\n'); commit(rb, 'next'); git(rb, 'switch', 'feature');
  put(rb, 'local.txt', 'unpushed HEAD\n'); commit(rb, 'local head');
  assert.equal((await request(`/api/agents/${ids.rebase}/git/rebase-safety?onto=main`)).blocked, true);
  await assert.rejects(action(ids.rebase, 'rebase', { onto: 'main' }), /force push/);

  // Fetch origin/default, then merge that fresh branch.
  const up = repos.update.work, clone = path.join(scratch, 'outside');
  git(scratch, 'clone', repos.update.bare, clone);
  git(clone, 'config', 'user.name', 'Branch Test'); git(clone, 'config', 'user.email', 'branch@test.invalid');
  await action(ids.update, 'branch', { name: 'feature', from: 'main', switch: true });
  put(clone, 'remote.txt', 'fresh\n'); commit(clone, 'remote update'); git(clone, 'push');
  r = await action(ids.update, 'update-default'); assert.equal(r.conflicted, false);
  assert.equal(readFileSync(path.join(up, 'remote.txt'), 'utf8').replace(/\r\n/g, '\n'), 'fresh\n');

  // Merged and unmerged local deletion, plus detached HEAD creation.
  const del = repos.delete.work;
  await action(ids.delete, 'branch', { name: 'merged', from: 'main', switch: false });
  await action(ids.delete, 'branch', { name: 'merged', delete: true });
  await action(ids.delete, 'branch', { name: 'unmerged', from: 'main', switch: true });
  put(del, 'unique.txt', 'unique\n'); commit(del, 'unique'); git(del, 'switch', 'main');
  await assert.rejects(action(ids.delete, 'branch', { name: 'unmerged', delete: true }), /not merged/);
  await action(ids.delete, 'branch', { name: 'unmerged', delete: true, force: true });
  git(del, 'checkout', '--detach', 'HEAD');
  r = await request(`/api/agents/${ids.delete}/git/status`); assert.equal(r.status.detached, true);
  await action(ids.delete, 'branch', { name: 'from-detached', from: git(del, 'rev-parse', 'HEAD'), switch: true });
  passed = true;
  console.log('Branch integration passed');
} finally {
  manager.kill();
  await delay(300);
  if (manager.exitCode === null) manager.kill('SIGKILL');
  // A failed run keeps its repositories for inspection. Only remove this script's verified scratch directory.
  if (passed && path.resolve(scratch).startsWith(project + path.sep) && path.basename(scratch).startsWith('.branch-test-')) rmSync(scratch, { recursive: true, force: true });
}
