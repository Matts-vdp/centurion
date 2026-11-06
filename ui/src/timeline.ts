import type { HistoryMessage, LiveMessage, QueuedMessage } from './api';

export type Source = { kind: 'user' } | { kind: 'orchestrator'; name: string } | { kind: 'manager' };

export type ToolItem = {
  kind: 'tool';
  key: string;
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** ms timestamp when we first saw the call (load time for history). */
  startedAt: number;
  result?: string;
  isError?: boolean;
  denied?: string;
};

export type Item =
  | { kind: 'prompt'; key: string; text: string; source: Source; fromHistory: boolean }
  | { kind: 'text'; key: string; text: string }
  | ToolItem
  | { kind: 'note'; key: string; text: string; level: 'info' | 'error' };

export type Transcript = {
  items: Item[];
  seen: Set<string>;
  /** tool_use_id → index in items */
  tools: Map<string, number>;
};

export const emptyTranscript = (): Transcript => ({ items: [], seen: new Set(), tools: new Map() });

const ORCH_PREFIX = /^\[Message from orchestrator "([^"]*)"\]\n?/;
const MANAGER_PREFIX = /^\[Manager notification\] ?/gm;

/** Who sent a prompt, derived from the prefix the manager adds; the prefix is stripped for display. */
export function parsePrompt(raw: string): { source: Source; text: string } {
  const orch = ORCH_PREFIX.exec(raw);
  if (orch) return { source: { kind: 'orchestrator', name: orch[1] }, text: raw.slice(orch[0].length) };
  if (raw.startsWith('[Manager notification]')) return { source: { kind: 'manager' }, text: raw.replace(MANAGER_PREFIX, '') };
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
    return content
      .map((c: Block) => (c.type === 'text' ? String(c.text ?? '') : `[${c.type}]`))
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content, null, 2);
}

let keySeq = 0;
const nextKey = (prefix: string) => `${prefix}-${++keySeq}`;

/** Interrupt markers Claude Code writes into the session as user text. */
const INTERRUPT_MARKER = /^\[Request interrupted by user/;

function pushPrompt(t: Transcript, raw: string, fromHistory: boolean): void {
  if (INTERRUPT_MARKER.test(raw)) {
    t.items.push({ kind: 'note', key: nextKey('note'), text: 'Interrupted by you', level: 'info' });
    return;
  }
  const { source, text } = parsePrompt(raw);
  t.items.push({ kind: 'prompt', key: nextKey('prompt'), text, source, fromHistory });
}

/**
 * Add one user or assistant message. Mutates `t`; callers copy `items` before handing it to React.
 * `fromHistory`: user prompts only come from history; live prompts come from `delivered` events.
 */
function addBody(t: Transcript, type: string, message: unknown, fromHistory: boolean): void {
  const blocks = blocksOf(message);
  if (blocks === null) return;
  if (type === 'user') {
    if (typeof blocks === 'string') {
      if (fromHistory) pushPrompt(t, blocks, true);
      return;
    }
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        const index = t.tools.get(String(b.tool_use_id));
        if (index === undefined) continue;
        const tool = t.items[index] as ToolItem;
        t.items[index] = { ...tool, result: toolResultText(b.content), isError: b.is_error === true || tool.isError };
      } else if (b.type === 'text' && fromHistory) {
        pushPrompt(t, String(b.text ?? ''), true);
      }
    }
    return;
  }
  if (type !== 'assistant' || typeof blocks === 'string') return;
  for (const b of blocks) {
    if (b.type === 'text') {
      const text = String(b.text ?? '');
      if (text.trim()) t.items.push({ kind: 'text', key: nextKey('text'), text });
    } else if (b.type === 'tool_use') {
      const id = String(b.id);
      t.tools.set(id, t.items.length);
      t.items.push({
        kind: 'tool',
        key: `tool-${id}`,
        id,
        name: String(b.name),
        input: (b.input as Record<string, unknown>) ?? {},
        startedAt: Date.now(),
      });
    }
    // thinking and redacted_thinking blocks stay hidden
  }
}

export function fromHistory(messages: HistoryMessage[]): Transcript {
  const t = emptyTranscript();
  for (const m of messages) {
    if (m.parent_tool_use_id) continue; // subagent internals stay hidden
    if (m.uuid) t.seen.add(m.uuid);
    addBody(t, m.type, m.message, true);
  }
  return t;
}

/** Apply a live event; returns a new transcript when something changed, else the same one. */
export function applyLive(t: Transcript, e: { kind: 'message'; message: LiveMessage } | { kind: 'delivered'; message: QueuedMessage }): Transcript {
  const next: Transcript = { items: [...t.items], seen: t.seen, tools: t.tools };
  if (e.kind === 'delivered') {
    // The history may already hold this prompt if it was fetched right after delivery.
    const last = [...next.items].reverse().find((i) => i.kind === 'prompt');
    const { text } = parsePrompt(e.message.text);
    if (last?.kind === 'prompt' && last.fromHistory && last.text === text && next.items.at(-1) === last) return t;
    pushPrompt(next, e.message.text, false);
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
    addBody(next, m.type, m.message, false);
    if (m.type === 'assistant' && typeof m.error === 'string') {
      next.items.push({ kind: 'note', key: nextKey('note'), text: `API error: ${m.error}`, level: 'error' });
    }
    return next;
  }
  // Turn results are not shown from here: an interrupt also ends with an error subtype, so the
  // transcript takes turn-end notes from the agent record's last reply instead (see addNote).
  if (m.type === 'system' && m.subtype === 'permission_denied') {
    const index = next.tools.get(String(m.tool_use_id));
    const reason = String(m.decision_reason ?? m.message ?? 'denied');
    if (index !== undefined) next.items[index] = { ...(next.items[index] as ToolItem), denied: reason, isError: true };
    next.items.push({ kind: 'note', key: nextKey('note'), text: `Permission denied: ${String(m.tool_name)} — ${reason}`, level: 'error' });
  } else if (m.type === 'system' && m.subtype === 'api_retry') {
    next.items.push({ kind: 'note', key: nextKey('note'), text: 'API error, retrying…', level: 'info' });
  } else if (m.type === 'system' && m.subtype === 'compact_boundary') {
    next.items.push({ kind: 'note', key: nextKey('note'), text: 'Conversation compacted', level: 'info' });
  }
  return next.items.length === before && next.items.every((i, n) => i === t.items[n]) ? t : next;
}

export function addNote(t: Transcript, text: string, level: 'info' | 'error'): Transcript {
  return { ...t, items: [...t.items, { kind: 'note', key: nextKey('note'), text, level }] };
}

/** The last tool call without a result, if any. */
export function pendingTool(t: Transcript): ToolItem | null {
  for (let i = t.items.length - 1; i >= 0; i--) {
    const item = t.items[i];
    if (item.kind === 'tool') return item.result === undefined && !item.denied ? item : null;
  }
  return null;
}
