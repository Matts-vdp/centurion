import {
  query,
  type Options,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentRecord, QueuedMessage, Reply } from './types.js';

const MAX_REPLIES = 20;

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

  constructor(
    public readonly rec: AgentRecord,
    private readonly hooks: RuntimeHooks,
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
    if (this.busy || this.stopping || this.rec.queue.length === 0) return;
    const next = this.takeNext();
    this.busy = true;
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
    this.stopping = true;
    this.input?.close();
    this.q?.close();
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
        this.hooks.onMessage(this.rec, message);
        if (message.type === 'result') this.finishTurn(message);
      }
    } catch (err) {
      error = err;
    }
    this.onExit(error);
  }

  private finishTurn(result: SDKResultMessage): void {
    const isError = result.is_error || result.subtype !== 'success';
    const text =
      result.subtype === 'success'
        ? result.result
        : `Turn ended with ${result.subtype}${'errors' in result && result.errors?.length ? `: ${result.errors.join('; ')}` : ''}`;
    this.rec.costUsd = result.total_cost_usd ?? this.rec.costUsd;
    this.endTurn({ text, at: new Date().toISOString(), isError }, isError ? 'error' : 'idle');
    this.pump();
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
    this.rec.replies.push(reply);
    if (this.rec.replies.length > MAX_REPLIES) this.rec.replies.splice(0, this.rec.replies.length - MAX_REPLIES);
    if (handled) this.hooks.onTurnEnd(this.rec, handled, reply);
    this.changed();
  }

  private onExit(error: unknown): void {
    const wasStopping = this.stopping;
    this.q = null;
    this.input = null;
    this.stopping = false;
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
