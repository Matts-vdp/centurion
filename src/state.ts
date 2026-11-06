import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentRecord, StateFile } from './types.js';

/**
 * JSON state on disk. Only this process writes it, always via a temp file and
 * a rename so a crash never leaves a half-written file. Writes are debounced.
 */
export class StateStore {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string) {}

  load(): AgentRecord[] {
    if (!existsSync(this.file)) return [];
    const data = JSON.parse(readFileSync(this.file, 'utf8')) as StateFile;
    // Records from older state files lack the newer fields.
    return (data.agents ?? []).map((rec) => ({
      ...rec,
      archived: rec.archived ?? false,
      lastActivityAt: rec.lastActivityAt ?? rec.updatedAt,
      context: rec.context ?? null,
    }));
  }

  /** Schedule a save; `getAgents` is read when the write actually happens. */
  save(getAgents: () => AgentRecord[]): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writeNow(getAgents());
    }, 100);
  }

  writeNow(agents: AgentRecord[]): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const data: StateFile = { version: 1, agents };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, this.file);
  }
}
