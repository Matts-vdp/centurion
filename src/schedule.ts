import { nextAfter, occurrencesBetween } from './cron.js';
import { randomUUID } from 'node:crypto';
import type { ScheduledRun, ScheduledTask } from './types.js';

export type DueDecision = { nextAt: string | null; status?: 'done'; runs: Pick<ScheduledRun, 'dueAt' | 'trigger' | 'status' | 'reason' | 'missed'>[] };

/** Decide what an overdue task means without reading the clock or mutating state. */
export function dueRuns(task: ScheduledTask, now: Date, catchUpDays: number, tickMs = 30_000): DueDecision {
  if (task.status !== 'active' || !task.nextAt || Date.parse(task.nextAt) > now.getTime()) return { nextAt: task.nextAt, runs: [] };
  const occurrences = occurrencesBetween(task.schedule, new Date(task.nextAt), now);
  if (!occurrences.length) return { nextAt: task.nextAt, runs: [] };
  const latest = occurrences.at(-1)!;
  const next = nextAfter(task.schedule, now)?.toISOString() ?? null;
  const result: DueDecision = { nextAt: next, ...(next ? {} : { status: 'done' }), runs: [] };
  const overlap = task.target.kind === 'newChat'
    ? task.runs.some((r) => r.status === 'waiting' || r.status === 'queued' || r.status === 'running') ? 'previous run still running' : null
    : task.runs.some((r) => r.status === 'waiting' || r.status === 'queued') ? 'previous run still queued' : null;
  const pending = task.runs.find((r) => r.status === 'pending');
  if (pending) result.runs.push({ dueAt: pending.dueAt, trigger: 'catchUp', status: 'skipped', reason: 'new occurrence arrived' });
  const missed = now.getTime() - latest.getTime() > tickMs || occurrences.length > 1;
  if (!missed) {
    if (occurrences.length > 1) result.runs.push({ dueAt: occurrences[0].toISOString(), trigger: 'schedule', status: 'skipped', reason: `missed while Centurion was off (${occurrences.length - 1} runs)` });
    result.runs.push({ dueAt: latest.toISOString(), trigger: 'schedule', status: overlap ? 'skipped' : 'waiting', ...(overlap ? { reason: overlap } : {}) });
    return result;
  }
  const inWindow = now.getTime() - latest.getTime() <= catchUpDays * 86_400_000;
  const dropped = occurrences.length - (inWindow && task.missedRuns !== 'skip' ? 1 : 0);
  if (dropped > 0) result.runs.push({ dueAt: occurrences[0].toISOString(), trigger: 'schedule', status: 'skipped', reason: `missed while Centurion was off (${dropped} runs)` });
  if (inWindow && task.missedRuns !== 'skip') result.runs.push({ dueAt: latest.toISOString(), trigger: 'catchUp', status: task.missedRuns === 'ask' ? 'pending' : overlap ? 'skipped' : 'waiting',
    ...(task.missedRuns !== 'ask' && overlap ? { reason: overlap } : {}), missed: occurrences.length - 1 });
  return result;
}

export type SchedulerHooks = {
  tasks: () => ScheduledTask[];
  paused: () => boolean;
  changed: (task: ScheduledTask) => void;
  startRun: (task: ScheduledTask, run: ScheduledRun) => void;
};

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private readyAt: number;
  private startedAt: number;
  constructor(private readonly hooks: SchedulerHooks, private readonly options: { enabled: boolean; catchUpDays: number; startupDelaySeconds: number; maxRunning: number }) {
    this.startedAt = Date.now();
    this.readyAt = this.startedAt + options.startupDelaySeconds * 1000;
    if (options.enabled) {
      this.timer = setInterval(() => this.tick(), 30_000);
      this.timer.unref();
      const startup = setTimeout(() => this.tick(), options.startupDelaySeconds * 1000);
      startup.unref();
    }
  }

  dispose(): void { if (this.timer) clearInterval(this.timer); }

  tick(now = new Date()): void {
    if (!this.options.enabled || this.hooks.paused()) return;
    for (const task of this.hooks.tasks()) {
      if (now.getTime() < this.readyAt && task.nextAt && Date.parse(task.nextAt) < this.startedAt) continue;
      const decision = dueRuns(task, now, this.options.catchUpDays);
      if (decision.nextAt === task.nextAt && !decision.runs.length) continue;
      task.nextAt = decision.nextAt;
      if (decision.status) task.status = decision.status;
      for (const item of decision.runs) {
        if (item.reason === 'new occurrence arrived') {
          const old = task.runs.find((r) => r.status === 'pending');
          if (old) { old.status = 'skipped'; old.reason = item.reason; old.endedAt = now.toISOString(); }
          continue;
        }
        task.runs.push({ id: randomUUID(), ...item, ...(item.status === 'skipped' ? { endedAt: now.toISOString() } : {}) });
      }
      task.runs = task.runs.slice(-50);
      task.updatedAt = now.toISOString();
      this.hooks.changed(task);
    }
    this.drain();
  }

  drain(): void {
    const tasks = this.hooks.tasks();
    let occupied = tasks.flatMap((t) => t.runs).filter((r) => r.status === 'queued' || r.status === 'running').length;
    for (const task of tasks) for (const run of task.runs) {
      if (run.status !== 'waiting' || occupied >= this.options.maxRunning) continue;
      if ((this.hooks.paused() || task.status === 'paused') && !run.requested) continue;
      this.hooks.startRun(task, run);
      const status = task.runs.find((item) => item.id === run.id)?.status;
      if (status === 'queued' || status === 'running') occupied++;
    }
  }
}
