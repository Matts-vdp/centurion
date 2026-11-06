import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentRecord, Plan, QuestionSet, StateFile } from './types.js';

export type State = { agents: AgentRecord[]; plans: Plan[]; questionSets: QuestionSet[] };

/**
 * JSON state on disk. Only this process writes it, always via a temp file and
 * a rename so a crash never leaves a half-written file. Writes are debounced.
 */
export class StateStore {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string) {}

  load(): State {
    if (!existsSync(this.file)) return { agents: [], plans: [], questionSets: [] };
    const data = JSON.parse(readFileSync(this.file, 'utf8')) as StateFile;
    // Records from older state files lack the newer fields.
    const agents = (data.agents ?? []).map((rec) => ({
      ...rec,
      archived: rec.archived ?? false,
      lastActivityAt: rec.lastActivityAt ?? rec.updatedAt,
      context: rec.context ?? null,
      turnStartedAt: rec.turnStartedAt ?? null,
    }));
    return { agents, plans: data.plans ?? [], questionSets: data.questionSets ?? [] };
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
    mkdirSync(path.dirname(this.file), { recursive: true });
    const data: StateFile = { version: 1, ...state };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, this.file);
  }
}
