import {
  query,
  type Options,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentRecord, ContextUsage, QueuedMessage, Reply } from './types.js';

const MAX_REPLIES = 20;

type InputUsage = {
  input_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

function inputTokens(u: InputUsage): number {
  return u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}

/** Async iterable the SDK reads user messages from; we push one per turn. */
class InputChannel implements AsyncIterable<SDKUserMessage> {
  private buffer: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(message: SDKUserMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.buffer.push(message);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters) waiter({ value: undefined, done: true });
    this.waiters = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const value = this.buffer.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

export type RuntimeHooks = {
  buildOptions(rec: AgentRecord): Options;
  onMessage(rec: AgentRecord, message: SDKMessage): void;
  /** A queued message was handed to the agent and its turn starts now. */
  onDeliver(rec: AgentRecord, message: QueuedMessage): void;
  /** Called once per handled queue message, also when the turn failed or was stopped. */
  onTurnEnd(rec: AgentRecord, handled: QueuedMessage, reply: Reply): void;
  onChange(rec: AgentRecord): void;
};

/**
 * One agent = one long-lived SDK session. Messages wait in `rec.queue` and are
 * delivered one at a time: the next is sent only after the previous turn's
 * `result` arrives, so every turn maps to exactly one queue entry.
 */
export class AgentRuntime {
  private q: Query | null = null;
  private input: InputChannel | null = null;
  private busy = false;
  private stopping = false;
  private hibernating = false;
  private idleTimer: NodeJS.Timeout | null = null;
  /** total_cost_usd is cumulative per query() call; we add the per-turn difference. */
  private lastTotalCost = 0;
  /** Set by interrupt(); the turn's result is then recorded as interrupted, not as an error. */
  private interrupting = false;
  /** Main model (from the init message) and the input size of the turn's last main-loop model call. */
  private model: string | null = null;
  private lastCallInput: number | null = null;

  constructor(
    public readonly rec: AgentRecord,
    private readonly hooks: RuntimeHooks,
    /** Close the process after this long without work; 0 keeps it alive. */
    private readonly idleMs = 0,
  ) {}

  get isBusy(): boolean {
    return this.busy;
  }

  enqueue(message: QueuedMessage): void {
    this.rec.queue.push(message);
    this.changed();
    this.pump();
  }

  /** Deliver the next queued message if the agent is free. */
  pump(): void {
    if (this.busy || this.stopping || this.hibernating || this.rec.queue.length === 0) return;
    this.clearIdleTimer();
    const next = this.takeNext();
    this.busy = true;
    this.interrupting = false;
    this.lastCallInput = null;
    this.rec.current = next;
    this.rec.status = 'running';
    this.rec.lastError = null;
    this.changed();
    this.hooks.onDeliver(this.rec, next);
    try {
      this.ensureStarted();
    } catch (err) {
      this.failTurn(err);
      return;
    }
    this.input!.push({
      type: 'user',
      message: { role: 'user', content: next.text },
      parent_tool_use_id: null,
    });
  }

  /** Cancel the current turn only. The queue and the process stay; the next queued message follows. */
  async interrupt(): Promise<boolean> {
    if (!this.busy || !this.q) return false;
    this.interrupting = true;
    try {
      await this.q.interrupt();
    } catch {
      // the turn may have just ended
    }
    return true;
  }

  /** Remove a message that is still waiting in the queue. */
  removeQueued(messageId: string): boolean {
    const index = this.rec.queue.findIndex((m) => m.id === messageId);
    if (index < 0) return false;
    this.rec.queue.splice(index, 1);
    this.changed();
    return true;
  }

  /** Stop the agent process. The queue is cleared; the next message resumes the session. */
  async stop(): Promise<QueuedMessage | null> {
    const handled = this.rec.current;
    this.rec.queue = [];
    if (!this.q) {
      this.rec.status = 'stopped';
      this.changed();
      return null;
    }
    this.stopping = true;
    try {
      await this.q.interrupt();
    } catch {
      // the process may already be gone
    }
    this.input?.close();
    this.q.close();
    return handled;
  }

  /** Close the process without changing the record (used on manager shutdown). */
  dispose(): void {
    this.clearIdleTimer();
    this.stopping = true;
    this.input?.close();
    this.q?.close();
  }

  private scheduleIdleClose(): void {
    this.clearIdleTimer();
    if (!this.idleMs || !this.q) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.busy || !this.q) return;
      // Free the process; the session is resumed on the next message.
      this.hibernating = true;
      this.input?.close();
      this.q.close();
    }, this.idleMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Combine consecutive manager notifications into one message so a busy orchestrator wakes once. */
  private takeNext(): QueuedMessage {
    const first = this.rec.queue.shift()!;
    if (first.source !== 'manager') return first;
    const batch = [first];
    while (this.rec.queue[0]?.source === 'manager') batch.push(this.rec.queue.shift()!);
    if (batch.length === 1) return first;
    return { ...first, text: batch.map((m) => m.text).join('\n\n'), notify: false };
  }

  private ensureStarted(): void {
    if (this.q) return;
    this.input = new InputChannel();
    this.lastTotalCost = 0;
    this.q = query({ prompt: this.input, options: this.hooks.buildOptions(this.rec) });
    void this.consume(this.q);
  }

  private async consume(q: Query): Promise<void> {
    let error: unknown = null;
    try {
      for await (const message of q) {
        if (message.type === 'system' && message.subtype === 'init' && this.rec.sessionId !== message.session_id) {
          this.rec.sessionId = message.session_id;
          this.changed();
        }
        if (message.type === 'system' && message.subtype === 'init') this.model = message.model;
        if (message.type === 'assistant' && message.parent_tool_use_id === null && message.message.usage) {
          this.lastCallInput = inputTokens(message.message.usage);
        }
        this.hooks.onMessage(this.rec, message);
        if (message.type === 'result') this.finishTurn(message);
      }
    } catch (err) {
      error = err;
    }
    this.onExit(error);
  }

  private finishTurn(result: SDKResultMessage): void {
    const interrupted = this.interrupting;
    this.interrupting = false;
    const isError = !interrupted && (result.is_error || result.subtype !== 'success');
    const text = interrupted
      ? 'Interrupted by the user.'
      : result.subtype === 'success'
        ? result.result
        : `Turn ended with ${result.subtype}${'errors' in result && result.errors?.length ? `: ${result.errors.join('; ')}` : ''}`;
    const total = result.total_cost_usd ?? this.lastTotalCost;
    this.rec.costUsd += Math.max(0, total - this.lastTotalCost);
    this.lastTotalCost = total;
    this.rec.context = this.contextUsage(result) ?? this.rec.context;
    const reply: Reply = { text, at: new Date().toISOString(), isError };
    if (interrupted) reply.interrupted = true;
    this.endTurn(reply, isError ? 'error' : 'idle');
    this.pump();
    if (!this.busy) this.scheduleIdleClose();
  }

  /**
   * Context in use after this turn. The result's `usage` adds up every model call of the turn, so it
   * overcounts once tools ran; the input of the last main-loop call is what is actually in the window.
   */
  private contextUsage(result: SDKResultMessage): ContextUsage | null {
    const entries = Object.entries(result.modelUsage ?? {});
    const size = (u: (typeof entries)[number][1]) => u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens;
    const main =
      entries.find(([key]) => key === this.model) ??
      entries.find(([key]) => !!this.model && (key.startsWith(this.model) || this.model.startsWith(key))) ??
      entries.sort((a, b) => size(b[1]) - size(a[1]))[0];
    const windowTokens = main?.[1].contextWindow;
    if (!windowTokens) return null;
    return { usedTokens: this.lastCallInput ?? inputTokens(result.usage), windowTokens };
  }

  private failTurn(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.endTurn({ text: `Agent failed: ${message}`, at: new Date().toISOString(), isError: true }, 'error');
  }

  private endTurn(reply: Reply, status: 'idle' | 'error' | 'stopped'): void {
    const handled = this.rec.current;
    this.rec.current = null;
    this.busy = false;
    this.rec.status = status;
    this.rec.lastError = reply.isError ? reply.text : null;
    this.rec.lastActivityAt = reply.at;
    this.rec.replies.push(reply);
    if (this.rec.replies.length > MAX_REPLIES) this.rec.replies.splice(0, this.rec.replies.length - MAX_REPLIES);
    if (handled) this.hooks.onTurnEnd(this.rec, handled, reply);
    this.changed();
  }

  private onExit(error: unknown): void {
    const wasStopping = this.stopping;
    const wasHibernating = this.hibernating;
    this.q = null;
    this.input = null;
    this.stopping = false;
    this.hibernating = false;
    this.clearIdleTimer();
    if (wasHibernating && !this.busy) {
      this.pump(); // a message may have been queued while the process was closing
      return;
    }
    if (this.busy) {
      if (wasStopping) {
        this.endTurn({ text: 'Stopped before the turn finished.', at: new Date().toISOString(), isError: true }, 'stopped');
      } else {
        this.failTurn(error ?? new Error('Agent process exited during a turn'));
      }
    } else if (wasStopping) {
      this.rec.status = 'stopped';
      this.changed();
    } else if (error) {
      this.rec.status = 'error';
      this.rec.lastError = error instanceof Error ? error.message : String(error);
      this.changed();
    }
    // Queued messages stay queued after a crash; the next enqueue restarts the process.
  }

  private changed(): void {
    this.rec.updatedAt = new Date().toISOString();
    this.hooks.onChange(this.rec);
  }
}
