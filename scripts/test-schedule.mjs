import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

process.env.TZ = 'Europe/Brussels';
const { nextAfter, preview, preset } = await import('../src/cron.ts');
const { dueRuns, Scheduler } = await import('../src/schedule.ts');
const { StateStore, StateError } = await import('../src/state.ts');
const { Manager } = await import('../src/manager.ts');
globalThis.location = { search: '', hash: '', pathname: '/' };
const { parsePrompt } = await import('../ui/src/timeline.ts');

const daily = preset('daily', '09:15');
const task = (nextAt, missedRuns = 'ask', schedule = daily) => ({
  id: 't', name: 'Test', prompt: 'ok', target: { kind: 'agent', agentId: 'a' }, schedule,
  status: 'active', missedRuns, unattended: 'deny', keepRuns: 5, nextAt, runs: [], createdAt: nextAt, updatedAt: nextAt,
});

test('cron presets and minimum interval', () => {
  assert.deepEqual(preview(daily, new Date('2026-11-08T07:00:00Z'), 1), ['2026-11-08T08:15:00.000Z']);
  assert.deepEqual(preview(preset('weekdays', '09:00'), new Date('2026-11-06T09:00:00Z'), 1), ['2026-11-09T08:00:00.000Z']);
  assert.throws(() => preview({ kind: 'cron', cron: '*/5 * * * *' }), /15 minutes/);
  assert.throws(() => preview({ kind: 'cron', cron: '* * *' }), /five cron fields/);
  assert.throws(() => preset('hourly', '09:00', [1], 7), /hourly interval/);
  assert.equal(nextAfter({ kind: 'manual' }, new Date()), null);
});

test('calendar and DST transitions use local time', () => {
  const march = preview(preset('daily', '09:00'), new Date('2026-03-28T00:00:00Z'), 3);
  assert.deepEqual(march, ['2026-03-28T08:00:00.000Z', '2026-03-29T07:00:00.000Z', '2026-03-30T07:00:00.000Z']);
  const october = preview(preset('daily', '09:00'), new Date('2026-10-24T00:00:00Z'), 3);
  assert.deepEqual(october, ['2026-10-24T07:00:00.000Z', '2026-10-25T08:00:00.000Z', '2026-10-26T08:00:00.000Z']);
  assert.equal(nextAfter({ kind: 'cron', cron: '0 9 29 2 *' }, new Date('2027-01-01T00:00:00Z'))?.toISOString(), '2028-02-29T08:00:00.000Z');
});

test('due decisions collapse missed occurrences', () => {
  const now = new Date('2026-11-08T12:00:00Z');
  const prior = '2026-11-05T08:15:00.000Z';
  const run = dueRuns(task(prior, 'run'), now, 7);
  assert.equal(run.runs.length, 2);
  assert.equal(run.runs[0].status, 'skipped');
  assert.equal(run.runs[1].status, 'waiting');
  assert.equal(run.runs[1].trigger, 'catchUp');
  assert.equal(run.runs[1].missed, 3);
  assert.equal(dueRuns(task(prior, 'ask'), now, 7).runs.at(-1).status, 'pending');
  assert.equal(dueRuns(task(prior, 'skip'), now, 7).runs.length, 1);
  assert.equal(dueRuns(task(prior, 'run'), now, 0).runs.length, 1);
  assert.equal(dueRuns(task('2026-11-08T08:15:00.000Z'), new Date('2026-11-08T08:15:10Z'), 7).runs[0].trigger, 'schedule');
});

test('overlap is decided when an occurrence becomes due', () => {
  const now = new Date('2026-11-08T08:15:10Z');
  const current = '2026-11-08T08:15:00Z';
  const newChat = { ...task(current), target: { kind: 'newChat', cwd: process.cwd(), model: null, effort: null },
    runs: [{ id: 'old', dueAt: '2026-11-07T08:15:00Z', trigger: 'schedule', status: 'running' }] };
  assert.equal(dueRuns(newChat, now, 7).runs.at(-1).reason, 'previous run still running');
  const existing = { ...task(current), runs: [{ id: 'old', dueAt: '2026-11-07T08:15:00Z', trigger: 'schedule', status: 'queued' }] };
  assert.equal(dueRuns(existing, now, 7).runs.at(-1).reason, 'previous run still queued');
});

test('once task and pending missed run', () => {
  const once = { kind: 'once', at: '2026-11-08T08:00:00Z' };
  const t = task(once.at, 'ask', once);
  const due = dueRuns(t, new Date('2026-11-08T10:00:00Z'), 7);
  assert.equal(due.status, 'done');
  assert.equal(due.runs[0].status, 'pending');
  const recurring = task('2026-11-08T08:15:00Z');
  recurring.runs = [{ id: 'r', dueAt: '2026-11-07T08:15:00Z', trigger: 'catchUp', status: 'pending' }];
  assert.equal(dueRuns(recurring, new Date('2026-11-08T08:15:10Z'), 7).runs[0].reason, 'new occurrence arrived');
});

test('scheduler holds a third run and respects global pause', () => {
  const tasks = [1, 2, 3].map((n) => ({ ...task(new Date(Date.now() + 60_000).toISOString(), 'skip', { kind: 'manual' }), id: `t${n}`,
    runs: [{ id: `r${n}`, dueAt: new Date().toISOString(), trigger: 'manual', status: 'waiting' }] }));
  let paused = true;
  const started = [];
  const scheduler = new Scheduler({ tasks: () => tasks, paused: () => paused, changed: () => {},
    startRun: (t, r) => { started.push(t.id); r.status = 'queued'; } },
    { enabled: true, catchUpDays: 7, startupDelaySeconds: 0, maxRunning: 2 });
  try {
    scheduler.tick();
    assert.deepEqual(started, []);
    scheduler.drain();
    assert.deepEqual(started, []);
    tasks[0].runs[0].requested = true;
    scheduler.drain();
    assert.deepEqual(started, ['t1']);
    paused = false;
    scheduler.tick();
    assert.deepEqual(started, ['t1', 't2']);
    assert.equal(tasks[2].runs[0].status, 'waiting');
    tasks[0].runs[0].status = 'done';
    scheduler.drain();
    assert.deepEqual(started, ['t1', 't2', 't3']);
  } finally { scheduler.dispose(); }
});

test('state migration and version guard', () => {
  const dir = mkdtempSync(path.join(process.cwd(), '.schedule-test-'));
  try {
    const file = path.join(dir, 'state.json');
    writeFileSync(file, JSON.stringify({ version: 1, agents: [] }));
    const store = new StateStore(file);
    assert.deepEqual(store.load().schedules, []);
    store.writeNow(store.load());
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 2);
    writeFileSync(file, JSON.stringify({ version: 3, agents: [] }));
    assert.throws(() => store.load(), StateError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scheduled prompt hides its prefix in the transcript', () => {
  const parsed = parsePrompt('[Scheduled task "daily" · catch-up: due 09:00, started 14:12]\nReply ok');
  assert.deepEqual(parsed, { source: { kind: 'schedule', name: 'daily', detail: 'catch-up: due 09:00, started 14:12' }, text: 'Reply ok' });
});

test('manual task can pause, resume and run without the automatic scheduler', () => {
  const dir = mkdtempSync(path.join(process.cwd(), '.schedule-test-'));
  const manager = new Manager({ stateFile: path.join(dir, 'state.json'), orchestratorFolder: process.cwd(),
    schedules: false, scheduleMissedRuns: 'ask', scheduleCatchUpDays: 7, scheduleStartupDelaySeconds: 0,
    scheduleMaxRunning: 2, idleMinutes: 10 });
  try {
    const created = manager.createSchedule({ name: 'Manual', prompt: 'ok', target: { kind: 'newChat', cwd: process.cwd(), model: null, effort: null }, schedule: { kind: 'manual' }, paused: true });
    assert.equal(created.status, 'paused');
    assert.equal(manager.setSchedulePaused(created.id, false).status, 'active');
    assert.equal(created.nextAt, null);
    manager.updateSchedule(created.id, { status: 'proposed', runs: [{ id: 'forged' }] });
    assert.equal(created.status, 'active');
    assert.deepEqual(created.runs, []);
  } finally { manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test('scheduled prompt file suggestions use the target folder', async () => {
  const dir = mkdtempSync(path.join(process.cwd(), '.schedule-test-'));
  writeFileSync(path.join(dir, 'note.txt'), 'hello');
  const manager = new Manager({ stateFile: path.join(dir, 'state.json'), orchestratorFolder: dir,
    schedules: false, scheduleMissedRuns: 'ask', scheduleCatchUpDays: 7, scheduleStartupDelaySeconds: 0,
    scheduleMaxRunning: 2, idleMinutes: 10 });
  try { assert.ok((await manager.scheduleFiles(dir)).files.includes('note.txt')); }
  finally { manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
