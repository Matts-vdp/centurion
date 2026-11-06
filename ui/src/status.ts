import type { AgentRecord } from './api';
import { isUnread, pendingFor, type Activity } from './store';
import { displayName } from './tools';

/**
 * The one state an agent shows (docs/ui-design.md, section 4). The order matters: the first that
 * applies wins.
 */
export type StateKey = 'running' | 'needs' | 'failed' | 'interrupted' | 'queued' | 'waiting' | 'unread' | 'stopped' | 'idle';

export type AgentState = {
  key: StateKey;
  /** Short status for the sidebar's second line. */
  line: string;
  /** Full sentence for the header's second line. */
  sentence: string;
  /** Experts that are running or queued (orchestrators only). */
  busyChildren: AgentRecord[];
};

export function agentState(
  a: AgentRecord,
  agents: Map<string, AgentRecord>,
  seen: Record<string, string>,
  activity: Activity | undefined,
  now: number,
): AgentState {
  // Only work that will report back to this orchestrator counts (messages with `notify`).
  const busyChildren =
    a.kind === 'orchestrator'
      ? [...agents.values()].filter(
          (c) => c.parentId === a.id && !c.archived && ((c.status === 'running' && c.current?.notify === true) || c.queue.some((m) => m.notify)),
        )
      : [];
  const ago = relativeTime(a.lastActivityAt, now);
  const make = (key: StateKey, line: string, sentence = line): AgentState => ({ key, line, sentence, busyChildren });

  if (a.status === 'running') {
    const started = a.turnStartedAt ? Date.parse(a.turnStartedAt) : null;
    const tool = activity?.tool;
    if (tool) {
      const label = displayName(tool.name);
      const since = duration(now - tool.since);
      return make('running', `Running ${label} · ${since}`, `Running ${label}${tool.detail ? `: ${tool.detail}` : ''} · ${since}`);
    }
    const t = started ? ` · ${duration(now - started)}` : '';
    return make('running', `Working${t}`, `Working${t}`);
  }
  if (a.kind === 'orchestrator') {
    const { plan, questions } = pendingFor(a.id);
    if (plan) {
      const v = plan.versions.at(-1)!;
      const n = v.tracks.length;
      return make('needs', `Plan ready · round ${plan.round}, ${n} track${n === 1 ? '' : 's'}`, `Plan ready for you · round ${plan.round}: ${v.title}`);
    }
    if (questions) {
      const line = `${questions} question${questions === 1 ? '' : 's'} for you`;
      return make('needs', line, `${line} · answer them in the question set`);
    }
  }
  if (a.status === 'error') {
    const err = firstLine(a.lastError ?? '');
    return make('failed', err ? `Failed · ${err}` : 'Failed', `Failed ${ago}${err ? ` · ${err}` : ''}`);
  }
  if (a.status === 'interrupted') return make('interrupted', 'Interrupted', `Interrupted ${ago} · send a message to continue`);
  if (a.queue.length > 0) return make('queued', `${a.queue.length} queued`, `${a.queue.length} queued · starts when the agent is free`);
  if (busyChildren.length > 0) {
    const n = busyChildren.length;
    const names = busyChildren.map((c) => c.name);
    return make(
      'waiting',
      `Waiting on ${n} expert${n === 1 ? '' : 's'}`,
      `Waiting on ${names.length <= 2 ? names.join(' and ') : `${n} experts`} · last turn ended ${ago}`,
    );
  }
  if (a.status === 'stopped') return make('stopped', 'Stopped', `Stopped ${ago} · the next message resumes it`);
  if (isUnread(a, seen)) return make('unread', `Replied ${ago}`, `Idle · replied ${ago}`);
  const never = a.replies.length === 0;
  return make('idle', never ? 'New' : `Idle · ${ago}`, never ? 'New · no messages yet' : `Idle · replied ${ago}`);
}

/** Roll-up of an orchestrator's experts, for its row when the tree is collapsed. */
export function rollup(children: AgentRecord[], seen: Record<string, string>): string {
  const count = (pred: (a: AgentRecord) => boolean) => children.filter(pred).length;
  const parts: string[] = [];
  const running = count((a) => a.status === 'running');
  const failed = count((a) => a.status === 'error');
  const interrupted = count((a) => a.status === 'interrupted');
  const unread = count((a) => a.status !== 'error' && isUnread(a, seen));
  if (running) parts.push(`${running} running`);
  if (failed) parts.push(`${failed} failed`);
  if (interrupted) parts.push(`${interrupted} interrupted`);
  if (unread) parts.push(`${unread} new`);
  return parts.join(' · ');
}

/**
 * Agents that need the user: failed or interrupted agents, and orchestrators whose last reply is
 * unread (it is the user's turn). An expert's unread reply goes to its orchestrator, not to the user.
 */
export function needsYou(a: AgentRecord, state: AgentState): boolean {
  if (a.archived) return false;
  if (state.key === 'needs' || state.key === 'failed' || state.key === 'interrupted') return true;
  return a.kind === 'orchestrator' && state.key === 'unread';
}

export function monogram(name: string): string {
  const parts = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (parts.length === 0) return '?';
  const letters = parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[1][0];
  return letters.toUpperCase();
}

/** The last part of a path: the folder name. */
export function folderName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function relativeTime(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Clock time for timestamps: 11:20 today, otherwise with the date. */
export function clock(at: number | string): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}

export function money(usd: number): string {
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
}

function firstLine(s: string, max = 80): string {
  const line = s.split('\n').find((l) => l.trim())?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
