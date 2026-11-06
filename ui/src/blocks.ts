import type { AgentRecord } from './api';
import type { Item, Notification, PromptItem, ThinkingItem, ToolItem } from './timeline';

type Reply = AgentRecord['replies'][number];

export type Step = ToolItem | ThinkingItem;

/** What the transcript renders: transcript items grouped into turns, work logs and footers. */
export type RenderBlock =
  | { kind: 'message'; key: string; item: PromptItem }
  | { kind: 'prose'; key: string; text: string }
  | { kind: 'work'; key: string; steps: Step[]; live: boolean }
  | { kind: 'event'; key: string; text: string; level: 'info' | 'error'; at?: number; notification?: Notification }
  | { kind: 'footer'; key: string; reply: Reply; tools: number; durationMs?: number };

type Turn = { prompt?: PromptItem; items: Item[]; reply?: Reply };

export function toBlocks(items: Item[], replies: Reply[], running: boolean): RenderBlock[] {
  const turns = splitTurns(items);
  assignReplies(turns, replies, running);
  const blocks: RenderBlock[] = [];
  turns.forEach((turn, n) => {
    const last = n === turns.length - 1;
    if (turn.prompt) blocks.push(...promptBlocks(turn.prompt));
    let work: Step[] = [];
    const flush = (live: boolean) => {
      if (work.length) blocks.push({ kind: 'work', key: `work-${work[0].key}`, steps: work, live });
      work = [];
    };
    for (const item of turn.items) {
      if (item.kind === 'tool' || item.kind === 'thinking') {
        work.push(item);
        continue;
      }
      flush(false);
      if (item.kind === 'text') blocks.push({ kind: 'prose', key: item.key, text: item.text });
      else if (item.kind === 'note') blocks.push({ kind: 'event', key: item.key, text: item.text, level: item.level, at: item.at });
    }
    flush(running && last);
    if (turn.reply) {
      const tools = turn.items.filter((i) => i.kind === 'tool').length;
      const durationMs = turn.reply.durationMs ?? (turn.prompt?.at ? Date.parse(turn.reply.at) - turn.prompt.at : undefined);
      blocks.push({ kind: 'footer', key: `footer-${turn.prompt?.key ?? n}`, reply: turn.reply, tools, durationMs });
    }
  });
  return blocks;
}

/** A manager prompt that only carries notifications becomes event lines; anything else is a message. */
function promptBlocks(p: PromptItem): RenderBlock[] {
  if (p.source.kind === 'manager' && p.notifications?.length) {
    return p.notifications.map((notification, i) => ({
      kind: 'event' as const,
      key: `${p.key}-n${i}`,
      text: `${notification.expertName} ${notification.text.replace(/\. Read the full reply with get_expert_output\.?$/, '').replace(/\.$/, '')}`,
      level: /error/.test(notification.text) ? ('error' as const) : ('info' as const),
      at: p.at,
      notification,
    }));
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
export function workSummary(steps: Step[], displayName: (n: string) => string): string {
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
