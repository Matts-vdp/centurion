import type { AgentRecord } from './api';
import type { Item, Notification, PromptItem, ThinkingItem, ToolItem } from './timeline';
import { displayName } from './tools';

type Reply = AgentRecord['replies'][number];

export type Step = ToolItem | ThinkingItem;

/** What the transcript renders: transcript items grouped into turns, work logs and footers. */
export type RenderBlock =
  | { kind: 'message'; key: string; item: PromptItem }
  | { kind: 'prose'; key: string; text: string }
  | { kind: 'work'; key: string; steps: Step[]; live: boolean }
  | { kind: 'event'; key: string; text: string; level: 'info' | 'error'; at?: number; notification?: Notification }
  | { kind: 'footer'; key: string; reply: Reply; tools: number; durationMs?: number }
  | Delegation
  | { kind: 'plan'; key: string; planId: string; version: number }
  | { kind: 'questions'; key: string; setId: string }
  /** A show_visual call the tool accepted: drawn in place of its step. */
  | { kind: 'visual'; key: string; title?: string; markup: string }
  /** An Agent / Task call: a subagent gets its own line instead of hiding in a work log. */
  | SubagentBlock;

/** An Agent / Task call. A background one ends later: its notification and report fold in here. */
export type SubagentBlock = {
  kind: 'subagent';
  key: string;
  tool: ToolItem;
  live: boolean;
  /** From `<task-notification>`: how a background subagent ended. */
  ended?: { status: string; summary: string };
  /** A background subagent's report, from its hand-back. */
  report?: string;
};

type Turn = { prompt?: PromptItem; items: Item[]; reply?: Reply };

/** create_expert or message_expert, with what came back about it folded in. */
export type Delegation = {
  kind: 'delegation';
  key: string;
  tool: ToolItem;
  /** null until create_expert returns the new expert's id. */
  expertId: string | null;
  expertName: string;
  message: string;
  /** The matching `[Manager notification]`, when it arrived. */
  notification?: Notification;
  notifiedAt?: number;
  /** The orchestrator read the reply with get_expert_output. */
  read: boolean;
  /** The plan track it names (track_id). */
  trackId?: string;
  /** The first delegation for its track since the last plan: the round tracker shows its state. */
  startsTrack: boolean;
};

export function toBlocks(items: Item[], replies: Reply[], running: boolean): RenderBlock[] {
  const turns = splitTurns(items);
  assignReplies(turns, replies, running);
  const blocks: RenderBlock[] = [];
  // expertId → the latest delegation to it, so notifications and reads can fold into it.
  const latest = new Map<string, Delegation>();
  // Subagents by tool call and by agent id, so background endings and reports can fold into them.
  const subs = { byTool: new Map<string, SubagentBlock>(), byAgent: new Map<string, SubagentBlock>() };
  // Track ids already started since the last plan block (ids like "t1" repeat from round to round).
  let startedTracks = new Set<string>();

  turns.forEach((turn, n) => {
    const last = n === turns.length - 1;
    if (turn.prompt) blocks.push(...promptBlocks(turn.prompt, latest, subs));
    let work: Step[] = [];
    const flush = (live: boolean) => {
      if (work.length) blocks.push({ kind: 'work', key: `work-${work[0].key}`, steps: work, live });
      work = [];
    };
    for (const item of turn.items) {
      if (item.kind === 'tool') {
        const name = displayName(item.name);
        if (name === 'create_expert' || name === 'message_expert') {
          flush(false);
          const d = delegation(item);
          if (d.trackId && !item.isError && !item.denied && !startedTracks.has(d.trackId)) {
            d.startsTrack = true;
            startedTracks.add(d.trackId);
          }
          if (d.expertId) latest.set(d.expertId, d);
          blocks.push(d);
          continue;
        }
        if (name === 'Agent' || name === 'Task') {
          flush(false);
          const sub: SubagentBlock = { kind: 'subagent', key: `subagent-${item.id}`, tool: item, live: running && last };
          subs.byTool.set(item.id, sub);
          const agentId = item.result ? /agentId: (\w+)/.exec(item.result)?.[1] : undefined;
          if (agentId) subs.byAgent.set(agentId, sub);
          blocks.push(sub);
          continue;
        }
        if ((name === 'propose_tracks' || name === 'ask_user') && item.result !== undefined && !item.isError) {
          const parsed = parseJson(item.result);
          if (name === 'propose_tracks' && typeof parsed.planId === 'string' && typeof parsed.version === 'number') {
            flush(false);
            startedTracks = new Set();
            blocks.push({ kind: 'plan', key: `plan-${item.id}`, planId: parsed.planId, version: parsed.version });
            continue;
          }
          if (name === 'ask_user' && typeof parsed.questionSetId === 'string') {
            flush(false);
            blocks.push({ kind: 'questions', key: `questions-${item.id}`, setId: parsed.questionSetId });
            continue;
          }
        }
        if (name === 'show_visual' && item.result !== undefined && !item.isError && typeof item.input.markup === 'string') {
          flush(false);
          const title = typeof item.input.title === 'string' && item.input.title.trim() ? item.input.title.trim() : undefined;
          blocks.push({ kind: 'visual', key: `visual-${item.id}`, title, markup: item.input.markup });
          continue;
        }
        if (name === 'get_expert_output' && typeof item.input.expert_id === 'string' && !item.isError) {
          const d = latest.get(item.input.expert_id);
          if (d) {
            d.read = true;
            continue;
          }
        }
      }
      if (item.kind === 'tool' || item.kind === 'thinking') {
        work.push(item);
        continue;
      }
      flush(false);
      if (item.kind === 'text') blocks.push({ kind: 'prose', key: item.key, text: item.text });
      else if (item.kind === 'note') blocks.push({ kind: 'event', key: item.key, text: item.text, level: item.level, at: item.at });
    }
    flush(running && last);
    // A turn Claude Code started itself for a background task that showed nothing: no footer either.
    const silent = (turn.prompt?.source.kind === 'task' || turn.prompt?.source.kind === 'handback') && turn.items.length === 0;
    if (turn.reply && !silent) {
      const tools = turn.items.filter((i) => i.kind === 'tool').length;
      const durationMs = turn.reply.durationMs ?? (turn.prompt?.at ? Date.parse(turn.reply.at) - turn.prompt.at : undefined);
      blocks.push({ kind: 'footer', key: `footer-${turn.prompt?.key ?? n}`, reply: turn.reply, tools, durationMs });
    }
  });
  return blocks;
}

function delegation(tool: ToolItem): Delegation {
  const i = tool.input;
  let expertId = typeof i.expert_id === 'string' ? i.expert_id : null;
  if (!expertId && tool.result && !tool.isError) {
    try {
      const parsed = JSON.parse(tool.result) as { id?: unknown };
      if (typeof parsed.id === 'string') expertId = parsed.id;
    } catch {
      // not JSON
    }
  }
  return {
    kind: 'delegation',
    key: `delegation-${tool.id}`,
    tool,
    expertId,
    expertName: typeof i.name === 'string' ? i.name : (expertId ?? 'expert'),
    message: typeof i.message === 'string' ? i.message : '',
    read: false,
    ...(typeof i.track_id === 'string' && i.track_id ? { trackId: i.track_id } : {}),
    startsTrack: false,
  };
}

/**
 * A manager prompt that only carries notifications: each one folds into the delegation it reports on,
 * or becomes an event line. Anything else is a message.
 */
function promptBlocks(
  p: PromptItem,
  latest: Map<string, Delegation>,
  subs: { byTool: Map<string, SubagentBlock>; byAgent: Map<string, SubagentBlock> },
): RenderBlock[] {
  // Claude Code's own messages about background subagents fold into the subagent's line.
  if (p.source.kind === 'task') {
    // A subagent's task id is its agent id; notifications written after a restart carry only that.
    const sub = subs.byTool.get(p.source.toolUseId) ?? subs.byAgent.get(p.source.taskId);
    if (sub) {
      sub.ended = { status: p.source.status, summary: p.source.summary };
      return [];
    }
    return [{ kind: 'event', key: p.key, text: p.text, level: p.source.status === 'failed' ? 'error' : 'info', at: p.at }];
  }
  if (p.source.kind === 'handback') {
    const sub = subs.byAgent.get(p.source.agentId);
    if (sub) {
      sub.report = p.source.report;
      return [];
    }
    return [{ kind: 'event', key: p.key, text: 'A subagent handed back its report', level: 'info', at: p.at }];
  }
  if (p.source.kind === 'manager' && p.notifications?.length) {
    const events: RenderBlock[] = [];
    p.notifications.forEach((notification, i) => {
      const d = latest.get(notification.expertId);
      if (d && !d.notification) {
        d.notification = notification;
        d.notifiedAt = p.at;
        return;
      }
      events.push({
        kind: 'event',
        key: `${p.key}-n${i}`,
        text: `${notification.expertName} ${notification.text.replace(/\. Read the full reply with get_expert_output\.?$/, '').replace(/\.$/, '')}`,
        level: /error/.test(notification.text) ? 'error' : 'info',
        at: p.at,
        notification,
      });
    });
    return events;
  }
  return [{ kind: 'message', key: p.key, item: p }];
}

function splitTurns(items: Item[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const item of items) {
    if (item.kind === 'prompt') {
      current = { prompt: item, items: [] };
      turns.push(current);
    } else {
      if (!current) {
        current = { items: [] };
        turns.push(current);
      }
      current.items.push(item);
    }
  }
  return turns;
}

/**
 * Tie the record's last replies (one per turn) to the turns they ended. With timestamps, a reply
 * belongs to the last turn that started before it; without, they pair up from the end.
 */
function assignReplies(turns: Turn[], replies: Reply[], running: boolean): void {
  const done = turns.filter((t, n) => t.prompt && !(running && n === turns.length - 1));
  if (done.length === 0 || replies.length === 0) return;
  if (done.every((t) => t.prompt?.at !== undefined)) {
    for (const reply of replies) {
      const at = Date.parse(reply.at);
      let owner: Turn | undefined;
      // The next prompt is only delivered after this reply was recorded, so no tolerance.
      for (const t of done) if (t.prompt!.at! <= at) owner = t;
      if (owner) owner.reply = reply;
    }
    return;
  }
  for (let i = 1; i <= Math.min(done.length, replies.length); i++) done[done.length - i].reply = replies[replies.length - i];
}

// ---------- work log summaries ----------

const CATEGORY: Record<string, [string, string]> = {
  Bash: ['ran', 'command'],
  Read: ['read', 'file'],
  Edit: ['edited', 'file'],
  Write: ['wrote', 'file'],
  NotebookEdit: ['edited', 'notebook'],
  Grep: ['ran', 'search'],
  Glob: ['ran', 'search'],
  WebFetch: ['fetched', 'page'],
  WebSearch: ['ran', 'web search'],
  Task: ['ran', 'subagent'],
  Agent: ['ran', 'subagent'],
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : word.endsWith('search') ? 'es' : 's'}`;

/** "ran 3 commands, read 2 files" */
export function workSummary(steps: Step[]): string {
  const counts = new Map<string, number>();
  let other = 0;
  for (const s of steps) {
    if (s.kind === 'thinking') continue;
    const cat = CATEGORY[displayName(s.name)];
    if (!cat) {
      other++;
      continue;
    }
    const key = `${cat[0]}|${cat[1]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([key, n]) => {
    const [verb, noun] = key.split('|');
    return `${verb} ${plural(n, noun)}`;
  });
  if (other) parts.push(`used ${plural(other, 'tool')}`);
  if (parts.length === 0) return 'thought';
  return parts.length > 3 ? `${parts.slice(0, 3).join(', ')} and more` : parts.join(', ');
}

/** Wall time of a run of steps, when it is known. */
export function workDuration(steps: Step[]): number | null {
  const starts = steps.map((s) => (s.kind === 'tool' ? s.startedAt : s.at));
  const ends = steps.map((s) => (s.kind === 'tool' ? (s.endedAt ?? s.startedAt) : s.at));
  const ms = Math.max(...ends) - Math.min(...starts);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
