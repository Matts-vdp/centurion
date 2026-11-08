import { randomUUID } from 'node:crypto';
import { query, type Options, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { InputChannel, ownCost } from './agent.js';
import type { AgentRecord } from './types.js';

/** A refused side chat request, with its HTTP status. */
export class SideChatError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The tools a side chat may use: they only read. Everything else is denied. */
export const SIDE_CHAT_TOOLS = ['Read', 'Glob', 'Grep'];
/** A side chat nobody used for this long is closed (the panel's close normally does it). */
const IDLE_MS = 30 * 60_000;
/** Model calls per question, tool steps included. */
const MAX_TURNS = 12;

/** What the `btw` event carries; `id` is the side chat's, `agentId` the agent it asks about. */
export type SideChatEvent = { id: string; agentId: string } & (
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; detail: string }
  | { type: 'done'; costUsd: number; totalCostUsd: number }
  | { type: 'error'; error: string }
  | { type: 'closed' }
);

export type SideChatHooks = {
  get(id: string): AgentRecord;
  /** The agent's own query options, so the fork's requests start with the session's cached prefix. */
  options(rec: AgentRecord): Options;
  /** Adds the side chat's cost to the agent's total (nothing else on the record changes). */
  addCost(id: string, usd: number): void;
  emit(e: SideChatEvent): void;
};

type SideChat = {
  id: string;
  agentId: string;
  q: Query;
  input: InputChannel;
  busy: boolean;
  /** `total_cost_usd` at the last result; null until the first, which may carry the session's restored counters. */
  lastTotal: number | null;
  costUsd: number;
  idle: NodeJS.Timeout | null;
};

/**
 * Side chats ("/btw"): questions about an agent's session that never enter it. Each is a throw-away fork of
 * the session (`forkSession`, `persistSession: false`) with the agent's own options, like a keep-warm ping, but
 * it answers in real turns and stays open for follow-ups until closed. Only read-only tools run. The agent's
 * status, queue, cache estimate and last activity don't change; its cost total does.
 */
export class SideChats {
  private readonly chats = new Map<string, SideChat>();

  constructor(private readonly hooks: SideChatHooks) {}

  /** Forks the agent's session and asks the first question. Works while the agent runs: the fork starts from what the session has saved. */
  start(agentId: string, text: string): { id: string } {
    const rec = this.hooks.get(agentId);
    if (!rec.sessionId) throw new SideChatError(409, `${rec.name} has no conversation yet; send it a message first`);
    const id = randomUUID();
    const deny = (reason: string) => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason },
    });
    const options: Options = {
      ...this.hooks.options(rec),
      resume: rec.sessionId,
      forkSession: true,
      persistSession: false,
      maxTurns: MAX_TURNS,
      includePartialMessages: true,
      // Tools stay defined (removing them would change the cached prefix); only the reading ones run.
      canUseTool: async () => ({ behavior: 'deny', message: 'This is a side question; only Read, Glob and Grep are available.' }),
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input) => {
                const name = (input as { tool_name?: string }).tool_name ?? '';
                return SIDE_CHAT_TOOLS.includes(name) ? {} : deny('Side question: only Read, Glob and Grep are available, nothing may change.');
              },
            ],
          },
        ],
      },
      stderr: () => {},
    };
    const input = new InputChannel();
    const q = query({ prompt: input, options });
    const chat: SideChat = { id, agentId, q, input, busy: false, lastTotal: null, costUsd: 0, idle: null };
    this.chats.set(id, chat);
    void this.read(chat);
    this.ask(id, text);
    return { id };
  }

  /** A follow-up in the same side thread; one question at a time. */
  ask(id: string, text: string): void {
    const chat = this.chat(id);
    if (chat.busy) throw new SideChatError(409, 'The side chat is still answering');
    if (!text.trim()) throw new SideChatError(400, 'The question is empty');
    chat.busy = true;
    this.touch(chat);
    chat.input.push({
      type: 'user',
      message: {
        role: 'user',
        content:
          '[A side question from the user, asked outside the conversation: it is not part of your task and is not saved. ' +
          'Answer it directly and briefly from what you know so far. You can read files (Read, Glob, Grep) but not change anything or run commands, and do not continue the task.]\n\n' +
          text,
      },
      parent_tool_use_id: null,
    });
  }

  close(id: string): void {
    const chat = this.chats.get(id);
    if (!chat) return;
    this.chats.delete(id);
    if (chat.idle) clearTimeout(chat.idle);
    chat.input.close();
    chat.q.close();
    this.hooks.emit({ id, agentId: chat.agentId, type: 'closed' });
  }

  /** Closes an agent's side chats (it was stopped or removed). */
  closeFor(agentId: string): void {
    for (const chat of [...this.chats.values()]) if (chat.agentId === agentId) this.close(chat.id);
  }

  dispose(): void {
    for (const id of [...this.chats.keys()]) this.close(id);
  }

  private chat(id: string): SideChat {
    const chat = this.chats.get(id);
    if (!chat) throw new SideChatError(404, 'That side chat is closed');
    return chat;
  }

  private touch(chat: SideChat): void {
    if (chat.idle) clearTimeout(chat.idle);
    chat.idle = setTimeout(() => this.close(chat.id), IDLE_MS);
    chat.idle.unref();
  }

  private async read(chat: SideChat): Promise<void> {
    const base = { id: chat.id, agentId: chat.agentId };
    try {
      for await (const m of chat.q) this.handle(chat, m);
      if (chat.busy) this.hooks.emit({ ...base, type: 'error', error: 'The side chat ended without an answer' });
    } catch (err) {
      if (this.chats.has(chat.id)) this.hooks.emit({ ...base, type: 'error', error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.close(chat.id);
    }
  }

  private handle(chat: SideChat, m: SDKMessage): void {
    const base = { id: chat.id, agentId: chat.agentId };
    if (m.type === 'stream_event' && m.parent_tool_use_id === null) {
      const ev = m.event;
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') this.hooks.emit({ ...base, type: 'delta', text: ev.delta.text });
      // A new text block after a tool step starts on its own paragraph.
      if (ev.type === 'content_block_start' && ev.content_block.type === 'text' && ev.index > 0) this.hooks.emit({ ...base, type: 'delta', text: '\n\n' });
      return;
    }
    if (m.type === 'assistant' && m.parent_tool_use_id === null) {
      for (const b of m.message.content) {
        if (b.type === 'tool_use') this.hooks.emit({ ...base, type: 'tool', name: b.name, detail: toolDetail(b.input) });
      }
      return;
    }
    if (m.type === 'result') {
      const total = m.total_cost_usd ?? 0;
      // The first result of a resumed process includes the session's restored cost counters.
      const cost = chat.lastTotal === null ? ownCost(m) : Math.max(0, total - chat.lastTotal);
      chat.lastTotal = total;
      chat.costUsd += cost;
      chat.busy = false;
      this.touch(chat);
      if (cost > 0) this.hooks.addCost(chat.agentId, cost);
      if (m.subtype !== 'success') this.hooks.emit({ ...base, type: 'error', error: `The answer ended with ${m.subtype}` });
      this.hooks.emit({ ...base, type: 'done', costUsd: cost, totalCostUsd: chat.costUsd });
    }
  }
}

function toolDetail(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const v = i.file_path ?? i.pattern ?? i.path ?? i.command ?? '';
  return typeof v === 'string' ? v : '';
}
