// Side chats (/btw): questions about an agent's conversation that never enter it. The manager answers
// them in a throw-away fork of the session; this module keeps each agent's open side thread (not saved
// anywhere: a reload or closing the panel ends it) and feeds it from the `btw` events.
import { useSyncExternalStore } from 'react';
import { commands } from './api';
import { store, type SideChatEvent } from './store';

export type SidePart = { kind: 'text'; text: string } | { kind: 'tool'; name: string; detail: string };

export type SideEntry = {
  question: string;
  parts: SidePart[];
  /** What this answer cost, once done. */
  costUsd: number | null;
  error: string | null;
  done: boolean;
};

export type SideChatState = {
  /** The manager's side chat; null before the first question and after it ended. */
  id: string | null;
  entries: SideEntry[];
  busy: boolean;
  /** Cost of the whole side thread. */
  costUsd: number;
  /** Text for the panel's field (a quoted selection), with a stamp so the field picks it up. */
  fill: { text: string; at: number } | null;
  /** The side chat ended by itself (idle or failed); the next question starts a new fork. */
  ended: boolean;
};

const EMPTY: SideChatState = { id: null, entries: [], busy: false, costUsd: 0, fill: null, ended: false };

class SideChats {
  /** agentId → its side thread, while the panel is open. */
  private chats = new Map<string, SideChatState>();
  private readonly listeners = new Set<() => void>();
  /** Events that arrived before their start request returned the side chat's id. */
  private readonly early = new Map<string, SideChatEvent[]>();

  constructor() {
    store.onSideChat((e) => this.onEvent(e));
    // Closing the tab ends the processes too (otherwise they close after 30 idle minutes).
    window.addEventListener('pagehide', () => {
      for (const c of this.chats.values()) if (c.id) void commands.btwClose(c.id);
    });
  }

  get = (agentId: string): SideChatState | undefined => this.chats.get(agentId);

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  use(agentId: string): SideChatState | undefined {
    return useSyncExternalStore(this.subscribe, () => this.chats.get(agentId));
  }

  private readonly views = new Map<string, number>();
  /** A pane shows the agent; when the last one goes (another agent, or the pane closed), the side chat ends. */
  attach(agentId: string): () => void {
    this.views.set(agentId, (this.views.get(agentId) ?? 0) + 1);
    return () => {
      const n = (this.views.get(agentId) ?? 1) - 1;
      if (n > 0) this.views.set(agentId, n);
      else {
        this.views.delete(agentId);
        this.close(agentId);
      }
    };
  }

  isOpen(agentId: string): boolean {
    return this.chats.has(agentId);
  }

  /** Opens the panel; with `question` it asks right away, with `quote` it puts the passage in the field. */
  open(agentId: string, opts: { question?: string; quote?: string } = {}): void {
    if (!this.chats.has(agentId)) this.set(agentId, EMPTY);
    if (opts.quote) this.update(agentId, (c) => ({ ...c, fill: { text: `${quoted(opts.quote!)}\n\n`, at: Date.now() } }));
    else this.update(agentId, (c) => ({ ...c, fill: { text: '', at: Date.now() } }));
    if (opts.question?.trim()) void this.ask(agentId, opts.question.trim());
  }

  toggle(agentId: string): void {
    if (this.chats.has(agentId)) this.close(agentId);
    else this.open(agentId);
  }

  async ask(agentId: string, text: string): Promise<void> {
    const chat = this.chats.get(agentId);
    if (!chat || chat.busy || !text.trim()) return;
    const entry: SideEntry = { question: text, parts: [], costUsd: null, error: null, done: false };
    this.update(agentId, (c) => ({ ...c, entries: [...c.entries, entry], busy: true, ended: false }));
    try {
      if (chat.id) {
        await commands.btwAsk(chat.id, text);
        return;
      }
      const { id } = await commands.btwStart(agentId, text);
      if (!this.chats.has(agentId)) {
        void commands.btwClose(id); // closed while it started
        return;
      }
      this.update(agentId, (c) => ({ ...c, id }));
      for (const e of this.early.get(id) ?? []) this.onEvent(e);
      this.early.delete(id);
    } catch (err) {
      this.finish(agentId, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  close(agentId: string): void {
    const chat = this.chats.get(agentId);
    if (!chat) return;
    if (chat.id) void commands.btwClose(chat.id);
    const next = new Map(this.chats);
    next.delete(agentId);
    this.chats = next;
    this.emit();
  }

  private onEvent(e: SideChatEvent): void {
    const chat = this.chats.get(e.agentId);
    if (!chat) return;
    if (chat.id !== e.id) {
      // Ours, before the start request returned its id; or an old one of this agent (ignored).
      if (chat.id === null && chat.busy) this.early.set(e.id, [...(this.early.get(e.id) ?? []), e]);
      return;
    }
    if (e.type === 'delta') {
      this.patchLast(e.agentId, (entry) => {
        const last = entry.parts.at(-1);
        const parts: SidePart[] =
          last?.kind === 'text' ? [...entry.parts.slice(0, -1), { kind: 'text', text: last.text + e.text }] : [...entry.parts, { kind: 'text', text: e.text.replace(/^\n+/, '') }];
        return { ...entry, parts };
      });
    } else if (e.type === 'tool') {
      this.patchLast(e.agentId, (entry) => ({ ...entry, parts: [...entry.parts, { kind: 'tool', name: e.name, detail: e.detail }] }));
    } else if (e.type === 'done') {
      this.finish(e.agentId, { costUsd: e.costUsd });
      this.update(e.agentId, (c) => ({ ...c, costUsd: e.totalCostUsd }));
    } else if (e.type === 'error') {
      this.finish(e.agentId, { error: e.error });
    } else if (e.type === 'closed') {
      const unfinished = chat.busy;
      if (unfinished) this.finish(e.agentId, { error: 'The side chat ended before it answered' });
      this.update(e.agentId, (c) => ({ ...c, id: null, busy: false, ended: true }));
    }
  }

  private finish(agentId: string, patch: { costUsd?: number; error?: string }): void {
    this.patchLast(agentId, (entry) => ({ ...entry, done: true, costUsd: patch.costUsd ?? entry.costUsd, error: patch.error ?? entry.error }));
    this.update(agentId, (c) => ({ ...c, busy: false }));
  }

  private patchLast(agentId: string, fn: (e: SideEntry) => SideEntry): void {
    this.update(agentId, (c) => (c.entries.length ? { ...c, entries: [...c.entries.slice(0, -1), fn(c.entries.at(-1)!)] } : c));
  }

  private update(agentId: string, fn: (c: SideChatState) => SideChatState): void {
    const chat = this.chats.get(agentId);
    if (chat) this.set(agentId, fn(chat));
  }

  private set(agentId: string, value: SideChatState): void {
    const next = new Map(this.chats);
    next.set(agentId, value);
    this.chats = next;
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

/** A passage as a markdown quote. */
export function quoted(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((l) => `> ${l}`.trimEnd())
    .join('\n');
}

export const sideChats = new SideChats();

/** `/btw <question>` in the composer: the question, or null when the text isn't one. */
export function btwQuestion(text: string): string | null {
  const m = /^\/btw(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? (m[1] ?? '') : null;
}
