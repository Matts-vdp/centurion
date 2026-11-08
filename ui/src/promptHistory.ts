/**
 * Prompts you sent, per browser, for Up / Down in the composer. Up goes through the agent's own prompts first
 * (newest first), then the other agents' prompts, so a prompt written for one agent is easy to send to another.
 */

const KEY = 'centurion-prompt-history';
const MAX = 300;

type Stored = { agentId: string; text: string; at: number };

export type Recalled = { agentId: string; text: string };

function read(): Stored[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((e): e is Stored => typeof e?.agentId === 'string' && typeof e?.text === 'string') : [];
  } catch {
    return [];
  }
}

export const promptHistory = {
  add(agentId: string, text: string): void {
    if (!text.trim()) return;
    // The same prompt again moves to the front instead of being kept twice.
    const list = read().filter((e) => !(e.agentId === agentId && e.text === text));
    list.push({ agentId, text, at: Date.now() });
    try {
      localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX)));
    } catch {
      // Storage full or blocked: history just isn't kept.
    }
  },

  /** What Up walks through for this agent: its own prompts, then everyone else's, each newest first, no repeats. */
  for(agentId: string): Recalled[] {
    const list = read().reverse();
    const seen = new Set<string>();
    const out: Recalled[] = [];
    for (const own of [true, false]) {
      for (const e of list) {
        if ((e.agentId === agentId) !== own || seen.has(e.text)) continue;
        seen.add(e.text);
        out.push({ agentId: e.agentId, text: e.text });
      }
    }
    return out;
  },
};
