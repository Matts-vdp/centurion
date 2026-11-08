import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentRecord, Plan, QuestionSet, ScheduledTask, StateFile } from './types.js';

/** The state file format this version writes. Bump it with a migration in `MIGRATIONS` when the format changes. */
export const STATE_VERSION = 2;

/** `MIGRATIONS[n]` turns a version-n file into a version n+1 file. */
const MIGRATIONS: Record<number, (data: any) => any> = { 1: (data) => ({ ...data, schedules: [] }) };

/** A state file this version can't use (written by a newer Centurion, or unreadable). */
export class StateError extends Error {}

/** Brings an older state file up to `STATE_VERSION`; refuses a newer one rather than overwriting it later. */
function migrate(file: string, data: any): StateFile {
  let version = typeof data?.version === 'number' ? data.version : 1;
  if (version > STATE_VERSION) {
    throw new StateError(
      `State file ${file} was written by a newer Centurion (state version ${version}; this one reads up to ${STATE_VERSION}). ` +
        'Upgrade Centurion, or point `stateFile` somewhere else.',
    );
  }
  while (version < STATE_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) throw new StateError(`State file ${file}: no migration from state version ${version}`);
    data = step(data);
    version += 1;
  }
  return { ...data, version } as StateFile;
}

export type State = { agents: AgentRecord[]; plans: Plan[]; questionSets: QuestionSet[]; schedules: ScheduledTask[]; schedulesPaused: boolean };

/**
 * JSON state on disk. Only this process writes it, always via a temp file and
 * a rename so a crash never leaves a half-written file. Writes are debounced.
 */
export class StateStore {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string) {}

  load(): State {
    if (!existsSync(this.file)) return { agents: [], plans: [], questionSets: [], schedules: [], schedulesPaused: false };
    const data = migrate(this.file, JSON.parse(readFileSync(this.file, 'utf8')));
    // Records from older state files lack the newer fields.
    const agents = (data.agents ?? []).map((rec) => ({
      ...rec,
      archived: rec.archived ?? false,
      archivedWith: rec.archivedWith ?? null,
      lastActivityAt: rec.lastActivityAt ?? rec.updatedAt,
      context: rec.context ?? null,
      turnStartedAt: rec.turnStartedAt ?? null,
      model: rec.model ?? null,
      effort: rec.effort ?? null,
      activeModel: rec.activeModel ?? null,
      activeEffort: rec.activeEffort ?? null,
    }));
    return { agents, plans: data.plans ?? [], questionSets: data.questionSets ?? [], schedules: data.schedules ?? [], schedulesPaused: data.schedulesPaused ?? false };
  }

  /** Schedule a save; `getState` is read when the write actually happens. */
  save(getState: () => State): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writeNow(getState());
    }, 100);
  }

  writeNow(state: State): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    mkdirSync(path.dirname(this.file), { recursive: true });
    const data: StateFile = { version: STATE_VERSION, ...state };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, this.file);
  }
}
