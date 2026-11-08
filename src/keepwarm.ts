import { query, type Options, type Query } from '@anthropic-ai/claude-agent-sdk';
import { InputChannel, cacheTtl, ownCost, type InputUsage } from './agent.js';
import { deliverable, keepWarmCapMinutes, type AgentRecord, type KeepWarmPing, type KeepWarmState } from './types.js';

/** A ping that hasn't answered by then is abandoned (and counts as failed). */
const PING_TIMEOUT_MS = 120_000;
/** A ping must read at least this share of the last turn's context from the cache to count as a hit. */
const HIT_SHARE = 0.5;

/** How long before the estimated expiry a ping goes out: a ping process takes a few seconds to start. */
function margin(ttlSeconds: number): number {
  return ttlSeconds >= 3600 ? 5 * 60_000 : 60_000;
}

export type KeepWarmHooks = {
  get(id: string): AgentRecord | undefined;
  children(id: string): AgentRecord[];
  isBusy(id: string): boolean;
  /** The agent's own query options: the ping must send exactly the prefix its next turn sends. */
  options(rec: AgentRecord): Options;
  /** Save and broadcast the record (this calls `check` again, which is idempotent). */
  changed(rec: AgentRecord): void;
};

type Plan = { nextAt: number | null; until: number | null; stopped?: string };

/**
 * Keeps an agent's prompt cache warm between turns. Every request that reads a cache entry restarts its
 * TTL at no extra charge, so shortly before the estimated expiry a ping goes out: a throw-away fork of the
 * agent's session (`forkSession`, `persistSession: false`) with the agent's own options and a one-line
 * prompt. Its request starts with the session's exact prefix, so it reads (and refreshes) the entry the
 * next real turn reads, and the session itself never sees it. Each ping's text differs, so the longest
 * match is always the session's own entry, not the previous ping's.
 */
export class KeepWarm {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Map<string, Query>();

  constructor(private readonly hooks: KeepWarmHooks) {}

  /** Plan the agent's next ping (or none) from its record; call after every change. */
  check(rec: AgentRecord): void {
    if (this.running.has(rec.id)) return; // the ping's end checks again
    const now = Date.now();
    const plan = this.plan(rec, now);
    this.clearTimer(rec.id);
    if (plan.nextAt !== null) {
      const timer = setTimeout(() => void this.ping(rec.id), Math.max(0, plan.nextAt - now));
      timer.unref();
      this.timers.set(rec.id, timer);
    }
    const prev = rec.warm ?? null;
    let next: KeepWarmState | null = null;
    if (active(rec)) {
      next = { nextAt: iso(plan.nextAt), until: iso(plan.until), pings: prev?.pings ?? 0, costUsd: prev?.costUsd ?? 0 };
      const stopped = plan.stopped ?? prev?.stopped;
      if (stopped) next.stopped = stopped;
      if (prev?.last) next.last = prev.last;
    }
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      rec.warm = next;
      this.hooks.changed(rec);
    }
  }

  dispose(): void {
    for (const id of [...this.timers.keys()]) this.clearTimer(id);
    for (const q of this.running.values()) q.close();
  }

  /** When the next ping is due, until when this episode pings, or why it stopped. */
  private plan(rec: AgentRecord, now: number): Plan {
    if (rec.replies.at(-1)?.scheduled) return { nextAt: null, until: null };
    const settings = rec.keepWarm;
    const cache = rec.cache;
    if (!settings || !active(rec) || !cache || !rec.sessionId || rec.archived) return { nextAt: null, until: null };
    const ttl = cache.ttlSeconds;
    const since = Date.parse(rec.lastActivityAt);
    const cap = since + keepWarmCapMinutes(ttl) * 60_000;
    const window = settings.minutes > 0 ? Math.min(cap, since + settings.minutes * 60_000) : 0;
    const working = settings.experts && rec.kind === 'orchestrator' && this.expertsWorking(rec.id);
    const until = Math.max(window, working ? cap : 0) || null;
    if (rec.warm?.stopped) return { nextAt: null, until };
    // Notifications held by a pause don't count: the chat is idle between the user's messages.
    if (this.hooks.isBusy(rec.id) || deliverable(rec).length > 0) return { nextAt: null, until };
    if (!until || now >= until) return { nextAt: null, until };
    const expires = Date.parse(cache.at) + ttl * 1000;
    // The cache lasts through the window by itself.
    if (expires >= until) return { nextAt: null, until };
    if (expires <= now) return { nextAt: null, until, stopped: 'The cache had already gone cold. Keep-warm starts again after the next turn.' };
    return { nextAt: Math.max(now, expires - margin(ttl)), until };
  }

  private expertsWorking(id: string): boolean {
    return this.hooks.children(id).some((c) => !c.archived && (c.status === 'running' || c.queue.length > 0));
  }

  private async ping(id: string): Promise<void> {
    this.timers.delete(id);
    const rec = this.hooks.get(id);
    if (!rec) return;
    const plan = this.plan(rec, Date.now());
    if (plan.nextAt === null || plan.nextAt > Date.now() + 1000) {
      this.check(rec);
      return;
    }
    const startedAt = Date.now();
    const turnAt = rec.lastActivityAt;
    const expected = rec.context?.usedTokens ?? 0;
    const n = (rec.warm?.pings ?? 0) + 1;
    let usage: InputUsage | null = null;
    let cost = 0;
    let error: string | undefined;
    try {
      ({ usage, cost } = await this.run(rec, n));
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      this.running.delete(id);
    }
    const read = usage?.cache_read_input_tokens ?? 0;
    const total = usage ? usage.input_tokens + read + (usage.cache_creation_input_tokens ?? 0) : 0;
    const ok = !error && read > 0 && read >= HIT_SHARE * (expected || total);
    const ping: KeepWarmPing = { at: new Date(startedAt).toISOString(), readTokens: read, expectedTokens: expected, costUsd: cost, ok };
    if (error) ping.error = error;
    rec.costUsd += cost;
    const warm: KeepWarmState = rec.warm ?? { nextAt: null, until: null, pings: 0, costUsd: 0 };
    warm.last = ping;
    // A turn ran meanwhile: it has a newer cache of its own, so only the cost is kept.
    if (rec.lastActivityAt === turnAt && !this.hooks.isBusy(id)) {
      warm.pings += 1;
      warm.costUsd += cost;
      if (ok && rec.cache) {
        rec.cache = { at: ping.at, ttlSeconds: (usage && cacheTtl(usage)) ?? rec.cache.ttlSeconds };
      } else if (!ok) {
        warm.stopped = error
          ? `The ping failed: ${error}`
          : `The ping read only ${read} of ${expected || total} tokens from the cache, so the cache had gone cold or changed. Keep-warm starts again after the next turn.`;
      }
    }
    rec.warm = warm;
    this.hooks.changed(rec);
  }

  /** One ping: the agent's session forked into a process that answers one line and is never saved. */
  private async run(rec: AgentRecord, n: number): Promise<{ usage: InputUsage; cost: number }> {
    const options: Options = {
      ...this.hooks.options(rec),
      resume: rec.sessionId!,
      forkSession: true,
      persistSession: false,
      maxTurns: 1,
      // Tools stay defined (removing them would change the prefix) but can't run.
      canUseTool: async () => ({ behavior: 'deny', message: 'This is a keep-alive ping; tools are not available.' }),
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async () => ({
                hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: 'Keep-alive ping' },
              }),
            ],
          },
        ],
      },
      stderr: () => {},
    };
    const input = new InputChannel();
    const q = query({ prompt: input, options });
    this.running.set(rec.id, q);
    input.push({
      type: 'user',
      message: { role: 'user', content: `Keep-alive ping ${n} from Centurion, to keep the prompt cache warm. Reply with only: ok` },
      parent_tool_use_id: null,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      q.close();
    }, PING_TIMEOUT_MS);
    let usage: InputUsage | null = null;
    let cost = 0;
    try {
      for await (const m of q) {
        if (m.type === 'assistant' && m.parent_tool_use_id === null && m.message.usage && !usage) usage = m.message.usage;
        if (m.type === 'result') {
          // The resumed process carries the session's restored cost counters; count only the ping.
          cost = ownCost(m);
          break;
        }
      }
    } finally {
      clearTimeout(timer);
      input.close();
      q.close();
    }
    if (!usage) throw new Error(timedOut ? 'no answer within 2 minutes' : 'the ping ended without an answer');
    return { usage, cost };
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }
}

/** Keep-warm is on: by time, or (chats) while experts work. */
export function active(rec: AgentRecord): boolean {
  const s = rec.keepWarm;
  return !!s && (s.minutes > 0 || (s.experts && rec.kind === 'orchestrator'));
}

function iso(t: number | null): string | null {
  return t === null ? null : new Date(t).toISOString();
}
