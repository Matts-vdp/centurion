import type { HistoryMessage, LiveMessage, QueuedMessage } from './api';

export type Source = { kind: 'user' } | { kind: 'orchestrator'; name: string } | { kind: 'manager' };

/** One `[Manager notification]` about an expert, parsed from a manager prompt. */
export type Notification = { expertName: string; expertId: string; text: string; preview: string };

export type ToolItem = {
  kind: 'tool';
  key: string;
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** ms timestamp of the call (from the session file, or when we saw it live). */
  startedAt: number;
  /** ms timestamp of the result. */
  endedAt?: number;
  result?: string;
  isError?: boolean;
  denied?: string;
};

export type ThinkingItem = { kind: 'thinking'; key: string; text: string; at: number };

export type PromptItem = {
  kind: 'prompt';
  key: string;
  text: string;
  source: Source;
  fromHistory: boolean;
  at?: number;
  /** Set for manager prompts: the notifications they carry. */
  notifications?: Notification[];
};

export type Item =
  | PromptItem
  | { kind: 'text'; key: string; text: string; at?: number }
  | ThinkingItem
  | ToolItem
  | { kind: 'note'; key: string; text: string; level: 'info' | 'error'; at?: number };

export type Transcript = {
  items: Item[];
  seen: Set<string>;
  /** tool_use_id → index in items */
  tools: Map<string, number>;
};

export const emptyTranscript = (): Transcript => ({ items: [], seen: new Set(), tools: new Map() });

const ORCH_PREFIX = /^\[Message from orchestrator "([^"]*)"\]\n?/;
const MANAGER_TAG = '[Manager notification]';
const NOTIFICATION = /^Expert "([^"]*)" \(id: ([^)]+)\) ([\s\S]*)$/;

/** Who sent a prompt, derived from the prefix the manager adds; the prefix is stripped for display. */
export function parsePrompt(raw: string): { source: Source; text: string; notifications?: Notification[] } {
  const orch = ORCH_PREFIX.exec(raw);
  if (orch) return { source: { kind: 'orchestrator', name: orch[1] }, text: raw.slice(orch[0].length) };
  if (raw.startsWith(MANAGER_TAG)) {
    const chunks = raw
      .split(MANAGER_TAG)
      .map((c) => c.trim())
      .filter(Boolean);
    const notifications: Notification[] = [];
    for (const chunk of chunks) {
      const m = NOTIFICATION.exec(chunk);
      if (!m) continue;
      const [what, ...rest] = m[3].split('\nPreview: ');
      notifications.push({ expertName: m[1], expertId: m[2], text: what.trim(), preview: rest.join('\nPreview: ').trim() });
    }
    return { source: { kind: 'manager' }, text: chunks.join('\n\n'), notifications };
  }
  return { source: { kind: 'user' }, text: raw };
}

type Block = { type: string; [key: string]: unknown };

function blocksOf(message: unknown): Block[] | string | null {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? (content as Block[]) : null;
}

export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c: Block) => (c.type === 'text' ? String(c.text ?? '') : `[${c.type}]`)).join('\n');
  }
  return content == null ? '' : JSON.stringify(content, null, 2);
}

let keySeq = 0;
const nextKey = (prefix: string) => `${prefix}-${++keySeq}`;

/** Interrupt markers Claude Code writes into the session as user text. The turn footer says it instead. */
const INTERRUPT_MARKER = /^\[Request interrupted by user/;

function pushPrompt(t: Transcript, raw: string, fromHistory: boolean, at: number | undefined): void {
  if (INTERRUPT_MARKER.test(raw)) return;
  const { source, text, notifications } = parsePrompt(raw);
  t.items.push({ kind: 'prompt', key: nextKey('prompt'), text, source, fromHistory, at, notifications });
}

/**
 * Add one user or assistant message. Mutates `t`; callers copy `items` before handing it to React.
 * `fromHistory`: user prompts only come from history; live prompts come from `delivered` events.
 */
function addBody(t: Transcript, type: string, message: unknown, fromHistory: boolean, at: number): void {
  const blocks = blocksOf(message);
  if (blocks === null) return;
  if (type === 'user') {
    if (typeof blocks === 'string') {
      if (fromHistory) pushPrompt(t, blocks, true, at);
      return;
    }
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        const index = t.tools.get(String(b.tool_use_id));
        if (index === undefined) continue;
        const tool = t.items[index] as ToolItem;
        t.items[index] = { ...tool, result: toolResultText(b.content), isError: b.is_error === true || tool.isError, endedAt: at };
      } else if (b.type === 'text' && fromHistory) {
        pushPrompt(t, String(b.text ?? ''), true, at);
      }
    }
    return;
  }
  if (type !== 'assistant' || typeof blocks === 'string') return;
  for (const b of blocks) {
    if (b.type === 'text') {
      const text = String(b.text ?? '');
      if (text.trim()) t.items.push({ kind: 'text', key: nextKey('text'), text, at });
    } else if (b.type === 'thinking') {
      const text = String(b.thinking ?? '');
      if (text.trim()) t.items.push({ kind: 'thinking', key: nextKey('thinking'), text, at });
    } else if (b.type === 'tool_use') {
      const id = String(b.id);
      t.tools.set(id, t.items.length);
      t.items.push({
        kind: 'tool',
        key: `tool-${id}`,
        id,
        name: String(b.name),
        input: (b.input as Record<string, unknown>) ?? {},
        startedAt: at,
      });
    }
    // redacted_thinking blocks stay hidden
  }
}

const timeOf = (m: HistoryMessage): number => {
  const ts = Date.parse(String((m as { timestamp?: unknown }).timestamp ?? ''));
  return Number.isNaN(ts) ? Date.now() : ts;
};

export function fromHistory(messages: HistoryMessage[]): Transcript {
  const t = emptyTranscript();
  for (const m of messages) {
    if (m.parent_tool_use_id) continue; // subagent internals stay hidden
    if (m.uuid) t.seen.add(m.uuid);
    addBody(t, m.type, m.message, true, timeOf(m));
  }
  return t;
}

/** Apply a live event; returns a new transcript when something changed, else the same one. */
export function applyLive(
  t: Transcript,
  e: { kind: 'message'; message: LiveMessage } | { kind: 'delivered'; message: QueuedMessage },
): Transcript {
  const next: Transcript = { items: [...t.items], seen: t.seen, tools: t.tools };
  if (e.kind === 'delivered') {
    // The history may already hold this prompt if it was fetched right after delivery.
    const last = [...next.items].reverse().find((i) => i.kind === 'prompt');
    const { text } = parsePrompt(e.message.text);
    if (last?.kind === 'prompt' && last.fromHistory && last.text === text && next.items.at(-1) === last) return t;
    pushPrompt(next, e.message.text, false, Date.now());
    return next;
  }
  const m = e.message;
  if (m.parent_tool_use_id) return t;
  if (m.uuid) {
    if (t.seen.has(m.uuid)) return t;
    t.seen.add(m.uuid);
  }
  const before = next.items.length;
  if (m.type === 'assistant' || m.type === 'user') {
    addBody(next, m.type, m.message, false, Date.now());
    if (m.type === 'assistant' && typeof m.error === 'string') {
      next.items.push({ kind: 'note', key: nextKey('note'), text: `API error: ${m.error}`, level: 'error', at: Date.now() });
    }
    return next;
  }
  // Turn results are not shown from here: the turn footer comes from the agent record's replies.
  if (m.type === 'system' && m.subtype === 'permission_denied') {
    const index = next.tools.get(String(m.tool_use_id));
    const reason = String(m.decision_reason ?? m.message ?? 'denied');
    if (index !== undefined) next.items[index] = { ...(next.items[index] as ToolItem), denied: reason, isError: true, endedAt: Date.now() };
    else next.items.push({ kind: 'note', key: nextKey('note'), text: `Permission denied: ${String(m.tool_name)} · ${reason}`, level: 'error' });
  } else if (m.type === 'system' && m.subtype === 'api_retry') {
    next.items.push({ kind: 'note', key: nextKey('note'), text: 'API error, retrying', level: 'info', at: Date.now() });
  } else if (m.type === 'system' && m.subtype === 'compact_boundary') {
    next.items.push({ kind: 'note', key: nextKey('note'), text: 'Conversation compacted', level: 'info', at: Date.now() });
  }
  return next.items.length === before && next.items.every((i, n) => i === t.items[n]) ? t : next;
}

/** The last tool call without a result, if any. */
export function pendingTool(t: Transcript): ToolItem | null {
  for (let i = t.items.length - 1; i >= 0; i--) {
    const item = t.items[i];
    if (item.kind === 'tool') return item.result === undefined && !item.denied ? item : null;
  }
  return null;
}
