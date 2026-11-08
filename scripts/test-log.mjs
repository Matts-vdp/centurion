// Integration exercise for git-plan step 7. `--serve` leaves the isolated manager up for browser checks.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const project = path.resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(path.join(project, '.log-test-'));
const port = 48000 + Math.floor(Math.random() * 10000);
const token = 'log-integration-test';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (repo, name, content) => writeFileSync(path.join(repo, name), content);
const commit = (repo, message) => { git(repo, 'add', '-A'); git(repo, 'commit', '-m', message); };
const bare = path.join(scratch, 'origin.git');
const work = path.join(scratch, 'work');
const clone = path.join(scratch, 'clone');
mkdirSync(bare); mkdirSync(work);
git(bare, 'init', '--bare', '--initial-branch=main');
git(work, 'init', '-b', 'main');
git(work, 'config', 'user.name', 'Log Test'); git(work, 'config', 'user.email', 'log@test.invalid');
put(work, 'base.txt', 'base\n'); commit(work, 'base');
git(work, 'remote', 'add', 'origin', bare); git(work, 'push', '-u', 'origin', 'main');
git(work, 'remote', 'set-head', 'origin', '-a');
git(work, 'switch', '-c', 'feature'); put(work, 'feature.txt', 'feature\n'); commit(work, 'feature work');
git(work, 'switch', 'main'); put(work, 'main.txt', 'main\n'); commit(work, 'main work');
git(work, 'merge', '--no-ff', 'feature', '-m', 'merge feature'); git(work, 'tag', 'v-test');
git(work, 'push', 'origin', 'main', 'feature', '--tags');
git(work, 'switch', '-c', 'local'); put(work, 'local.txt', 'unpushed\n'); commit(work, 'local only');
git(work, 'switch', 'main');
git(scratch, 'clone', bare, clone);
git(clone, 'config', 'user.name', 'Remote Test'); git(clone, 'config', 'user.email', 'remote@test.invalid');
put(clone, 'incoming.txt', 'incoming\n'); commit(clone, 'incoming work'); git(clone, 'push');
git(work, 'fetch', 'origin');
put(work, 'outgoing.txt', 'outgoing\n'); commit(work, 'outgoing work');

const config = path.join(scratch, 'config.json');
writeFileSync(config, JSON.stringify({ port, token, stateFile: path.join(scratch, 'state', 'state.json'), orchestratorFolder: work, removeEnv: Object.keys(process.env).filter((k) => /^CLAUDE|^ANTHROPIC_/i.test(k)) }));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE|^ANTHROPIC_/i.test(k)));
const manager = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'start', '--config', config], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let output = '';
manager.stdout.on('data', (b) => output += b);
manager.stderr.on('data', (b) => output += b);
const request = async (url, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const data = await res.json();
  assert(res.ok, `${res.status} ${data.error ?? ''}`);
  return data;
};
try {
  let ready = false;
  for (let i = 0; i < 80; i++) { try { await request('/api/info'); ready = true; break; } catch { await delay(100); } }
  assert(ready, `Manager did not start: ${output}`);
  const agent = await request('/api/agents', { name: 'Log scratch' });
  const base = `/api/agents/${agent.id}/git`;
  const log = await request(`${base}/log?root=0&scope=all`);
  assert(log.commits.some((c) => c.subject === 'outgoing work' && !c.pushed));
  assert(log.commits.some((c) => c.subject === 'incoming work' && c.incoming));
  assert(log.commits.some((c) => c.subject === 'merge feature' && c.parents.length === 2 && c.refs.some((r) => r.kind === 'tag')));
  assert(log.commits.some((c) => c.subject === 'local only'));
  const merge = log.commits.find((c) => c.subject === 'merge feature');
  const details = await request(`${base}/commit/${merge.hash}?root=0`);
  assert(details.files.some((f) => f.path === 'feature.txt'));
  const diff = await request(`${base}/commit/${merge.hash}?root=0&path=feature.txt`);
  assert.match(diff.diff, /feature/);
  const filtered = await request(`${base}/log?root=0&filter=remote%20test`);
  assert(filtered.commits.some((c) => c.subject === 'incoming work'));
  console.log(JSON.stringify({ scratch, port, token, agentId: agent.id, managerPid: manager.pid, url: `http://127.0.0.1:${port}/?token=${token}#agent=${agent.id}` }));
  if (process.argv.includes('--serve')) await new Promise((resolve) => { process.on('SIGINT', resolve); process.on('SIGTERM', resolve); });
} finally { manager.kill(); if (!process.argv.includes('--serve')) rmSync(scratch, { recursive: true, force: true }); }
