import type { HistoryMessage, LiveMessage, QueuedMessage } from './api';
import { modelLabel } from './models';

export type Source =
  | { kind: 'user' }
  | { kind: 'orchestrator'; name: string }
  | { kind: 'manager' }
  /** Claude Code itself: a background subagent ended (`<task-notification>`) or handed back its report. */
  | { kind: 'task'; toolUseId: string; taskId: string; status: string; summary: string }
  | { kind: 'handback'; agentId: string; report: string };

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
  /** The session's uuid for this prompt, where fork and rewind cut. */
  uuid?: string;
};

export type Item =
  | PromptItem
  | { kind: 'text'; key: string; text: string; at?: number }
  | ThinkingItem
  | ToolItem
  | { kind: 'note'; key: string; text: string; level: 'info' | 'error'; at?: number };

/** What a subagent did, from the live stream: its own steps and the task events about it. */
export type Sub = {
  items: Item[];
  /** tool_use_id → index in items */
  tools: Map<string, number>;
  /** The latest one-line progress summary (task_progress). */
  summary?: string;
  /** Set by task_notification: how it ended (background subagents end after their tool call returned). */
  ended?: 'completed' | 'failed' | 'stopped';
  toolUses?: number;
  durationMs?: number;
};

export type Transcript = {
  items: Item[];
  seen: Set<string>;
  /** tool_use_id → index in items */
  tools: Map<string, number>;
  /** Agent / Task tool_use_id → what its subagent did, live. */
  subs: Map<string, Sub>;
};

export const emptyTranscript = (): Transcript => ({ items: [], seen: new Set(), tools: new Map(), subs: new Map() });

const emptySub = (): Sub => ({ items: [], tools: new Map() });

const ORCH_PREFIX = /^\[Message from orchestrator "([^"]*)"\]\n?/;
const MANAGER_TAG = '[Manager notification]';
const NOTIFICATION = /^Expert "([^"]*)" \(id: ([^)]+)\) ([\s\S]*)$/;

/** Who sent a prompt, derived from the prefix the manager adds; the prefix is stripped for display. */
const TASK_NOTIFICATION = /^<task-notification>([\s\S]*)<\/task-notification>/;
const HANDBACK = /^(?:Another Claude session sent a message:\s*)?<agent-message from="([^"]+)">\s*\[Subagent hand-back\]([\s\S]*?)<\/agent-message>/;

const tag = (body: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1]?.trim() ?? '';

/** The report inside a hand-back: after "The report follows:", every line indented by the harness. */
function handbackReport(body: string): string {
  const at = body.indexOf('The report follows:');
  const lines = (at >= 0 ? body.slice(at + 'The report follows:'.length) : body).replace(/^\n/, '').split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length));
  return lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n').trim();
}

export function parsePrompt(raw: string): { source: Source; text: string; notifications?: Notification[] } {
  const task = TASK_NOTIFICATION.exec(raw.trim());
  if (task) {
    const body = task[1];
    const source: Source = { kind: 'task', toolUseId: tag(body, 'tool-use-id'), taskId: tag(body, 'task-id'), status: tag(body, 'status'), summary: tag(body, 'summary') };
    return { source, text: source.summary || 'A background task ended' };
  }
  const handback = HANDBACK.exec(raw.trim());
  if (handback) {
    const report = handbackReport(handback[2]);
    return { source: { kind: 'handback', agentId: handback[1], report }, text: report };
  }
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

/** Output of a session command, e.g. the manager switching the model: "Set model to `sonnet (claude-sonnet-5-5)`". */
const COMMAND_OUTPUT = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>\s*$/;
const COMMAND_NAME = /^<command-name>/;
const MODEL_SET = /^Set model to (\S+)(?: \(([^)]+)\))?/;
/** A slash command the user typed (e.g. a skill: `/orchestrate …`), as Claude Code stores it. */
const SLASH_COMMAND = /^<command-message>[\s\S]*?<\/command-message>\s*<command-name>([^<]*)<\/command-name>(?:\s*<command-args>([\s\S]*?)<\/command-args>)?/;

function pushPrompt(t: Pick<Transcript, 'items'>, raw: string, fromHistory: boolean, at: number | undefined, uuid?: string): void {
  if (INTERRUPT_MARKER.test(raw)) return;
  const slash = SLASH_COMMAND.exec(raw.trim());
  if (slash) raw = [slash[1].trim(), slash[2]?.trim()].filter(Boolean).join(' ');
  // The command itself (`<command-name>/model</command-name>…`) stays hidden; its output becomes an event line.
  if (COMMAND_NAME.test(raw.trim())) return;
  const command = COMMAND_OUTPUT.exec(raw.trim());
  if (command) {
    const out = command[1].replaceAll('`', '').trim();
    const model = MODEL_SET.exec(out);
    const text = model ? `Model switched to ${modelLabel(model[2] ?? model[1])}` : out;
    if (text) t.items.push({ kind: 'note', key: nextKey('note'), text, level: 'info', at });
    return;
  }
  const { source, text, notifications } = parsePrompt(raw);
  t.items.push({ kind: 'prompt', key: nextKey('prompt'), text, source, fromHistory, at, notifications, uuid });
}

/**
 * Add one user or assistant message. Mutates `t`; callers copy `items` before handing it to React.
 * `fromHistory`: user prompts only come from history; live prompts come from `delivered` events.
 */
function addBody(t: Pick<Transcript, 'items' | 'tools'>, type: string, message: unknown, fromHistory: boolean, at: number, uuid?: string): void {
  const blocks = blocksOf(message);
  if (blocks === null) return;
  if (type === 'user') {
    if (typeof blocks === 'string') {
      if (fromHistory) pushPrompt(t, blocks, true, at, uuid);
      return;
    }
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        const index = t.tools.get(String(b.tool_use_id));
        if (index === undefined) continue;
        const tool = t.items[index] as ToolItem;
        t.items[index] = { ...tool, result: toolResultText(b.content), isError: b.is_error === true || tool.isError, endedAt: at };
      } else if (b.type === 'text' && fromHistory) {
        pushPrompt(t, String(b.text ?? ''), true, at, uuid);
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

/** A subagent's steps and prose from its own transcript (its prompt is the tool call's input). */
export function fromSubagent(messages: HistoryMessage[]): Item[] {
  const t = { items: [] as Item[], tools: new Map<string, number>() };
  for (const m of messages) addBody(t, m.type, m.message, false, timeOf(m));
  return t.items;
}

export function fromHistory(messages: HistoryMessage[]): Transcript {
  const t = emptyTranscript();
  for (const m of messages) {
    if (m.parent_tool_use_id) continue; // subagent transcripts load on demand (fromSubagent)
    if (m.uuid) t.seen.add(m.uuid);
    addBody(t, m.type, m.message, true, timeOf(m), m.uuid);
  }
  return t;
}

/** Apply a live event; returns a new transcript when something changed, else the same one. */
export function applyLive(
  t: Transcript,
  e: { kind: 'message'; message: LiveMessage } | { kind: 'delivered'; message: QueuedMessage },
): Transcript {
  const next: Transcript = { items: [...t.items], seen: t.seen, tools: t.tools, subs: t.subs };
  if (e.kind === 'delivered') {
    // The history may already hold this prompt if it was fetched right after delivery.
    const last = [...next.items].reverse().find((i) => i.kind === 'prompt');
    const { text } = parsePrompt(e.message.text);
    if (last?.kind === 'prompt' && last.fromHistory && last.text === text && next.items.at(-1) === last) return t;
    pushPrompt(next, e.message.text, false, Date.now(), e.message.uuid);
    return next;
  }
  const m = e.message;
  if (m.uuid) {
    if (t.seen.has(m.uuid)) return t;
    t.seen.add(m.uuid);
  }
  // Inside a subagent: its steps go to its own list, keyed by the tool call that started it.
  if (m.parent_tool_use_id && (m.type === 'assistant' || m.type === 'user')) {
    const prev = t.subs.get(m.parent_tool_use_id) ?? emptySub();
    const sub: Sub = { ...prev, items: [...prev.items], tools: new Map(prev.tools) };
    addBody(sub, m.type, m.message, false, Date.now());
    return withSub(t, m.parent_tool_use_id, sub);
  }
  if (m.parent_tool_use_id) return t;
  if (m.type === 'system' && typeof m.tool_use_id === 'string' && (m.subtype === 'task_progress' || m.subtype === 'task_notification')) {
    const prev = t.subs.get(m.tool_use_id) ?? emptySub();
    const usage = m.usage as { tool_uses?: number; duration_ms?: number } | undefined;
    const sub: Sub = { ...prev };
    if (m.subtype === 'task_progress' && typeof m.summary === 'string' && m.summary.trim()) sub.summary = m.summary.trim();
    if (m.subtype === 'task_notification') sub.ended = m.status as Sub['ended'];
    if (typeof usage?.tool_uses === 'number') sub.toolUses = usage.tool_uses;
    if (typeof usage?.duration_ms === 'number') sub.durationMs = usage.duration_ms;
    return withSub(t, m.tool_use_id, sub);
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

function withSub(t: Transcript, toolUseId: string, sub: Sub): Transcript {
  const subs = new Map(t.subs);
  subs.set(toolUseId, sub);
  return { ...t, subs };
}

/** The last tool call without a result, if any. */
export function pendingTool(t: Transcript): ToolItem | null {
  for (let i = t.items.length - 1; i >= 0; i--) {
    const item = t.items[i];
    if (item.kind === 'tool') return item.result === undefined && !item.denied ? item : null;
  }
  return null;
}
