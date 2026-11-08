import { Cron } from 'croner';
import type { ScheduleSpec } from './types.js';

const MIN_GAP = 15 * 60_000;
const cache = new Map<string, Cron>();
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function expression(cron: string): Cron {
  const cached = cache.get(cron);
  if (cached) return cached;
  if (cron.trim().split(/\s+/).length !== 5) throw new Error('Use five cron fields: minute hour day month weekday');
  let job: Cron;
  try { job = new Cron(cron, { domAndDow: false }); }
  catch (error) { throw new Error(`Invalid cron: ${(error as Error).message}`); }
  const times = job.nextRuns(2000, new Date());
  if (!times.length) throw new Error('This schedule has no upcoming runs');
  for (let i = 1; i < times.length; i++) {
    if (times[i].getTime() - times[i - 1].getTime() < MIN_GAP) throw new Error('Scheduled runs must be at least 15 minutes apart');
  }
  cache.set(cron, job);
  return job;
}

export function validateSchedule(spec: ScheduleSpec): void {
  if (!spec || typeof spec !== 'object') throw new Error('Choose a schedule');
  if (spec.kind === 'cron') {
    if (typeof spec.cron !== 'string') throw new Error('Enter a cron expression');
    expression(spec.cron);
  } else if (spec.kind === 'once') {
    if (typeof spec.at !== 'string' || !Number.isFinite(Date.parse(spec.at))) throw new Error('Enter a valid date and time');
  } else if (spec.kind !== 'manual') throw new Error('Unknown schedule kind');
}

export function nextAfter(spec: ScheduleSpec, after: Date): Date | null {
  if (spec.kind === 'manual') return null;
  if (spec.kind === 'once') {
    const at = new Date(spec.at);
    return at > after ? at : null;
  }
  return expression(spec.cron).nextRun(after);
}

export function occurrencesBetween(spec: ScheduleSpec, from: Date, to: Date, max = 10000): Date[] {
  const out: Date[] = [];
  let cursor = new Date(from.getTime() - 1000);
  for (let i = 0; i < max; i++) {
    const next = nextAfter(spec, cursor);
    if (!next || next > to) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

export function preview(spec: ScheduleSpec, after = new Date(), count = 3): string[] {
  validateSchedule(spec);
  const out: string[] = [];
  let cursor = after;
  for (let i = 0; i < count; i++) {
    const next = nextAfter(spec, cursor);
    if (!next) break;
    out.push(next.toISOString());
    cursor = next;
  }
  return out;
}

export function describe(spec: ScheduleSpec): string {
  if (spec.kind === 'manual') return 'Manual only';
  if (spec.kind === 'once') return `Once ${new Date(spec.at).toLocaleString()}`;
  if (spec.label) return spec.label;
  return `Cron ${spec.cron}`;
}

export function preset(kind: 'hourly' | 'daily' | 'weekdays' | 'weekly', time = '09:00', days: number[] = [1], everyHours = 1): ScheduleSpec {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match || +match[1] > 23 || +match[2] > 59) throw new Error('Time must be HH:MM');
  const [hour, minute] = [+match[1], +match[2]];
  if (kind === 'hourly') {
    if (!Number.isInteger(everyHours) || everyHours < 1 || everyHours > 24 || 24 % everyHours !== 0) throw new Error('Choose an hourly interval of 1, 2, 3, 4, 6, 8, 12 or 24 hours');
    return { kind: 'cron', cron: `${minute} ${everyHours === 1 ? '*' : `*/${everyHours}`} * * *`, label: everyHours === 1 ? `Hourly at :${String(minute).padStart(2, '0')}` : `Every ${everyHours} hours` };
  }
  if (kind === 'daily') return { kind: 'cron', cron: `${minute} ${hour} * * *`, label: `Daily ${time}` };
  if (kind === 'weekdays') return { kind: 'cron', cron: `${minute} ${hour} * * 1-5`, label: `Weekdays ${time}` };
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('Choose weekday numbers from 0 (Sunday) to 6');
  return { kind: 'cron', cron: `${minute} ${hour} * * ${days.join(',')}`, label: `Weekly ${days.map((day) => DAYS[day]).join(', ')} ${time}` };
}
