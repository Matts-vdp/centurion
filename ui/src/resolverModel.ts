import type { Conflict } from './fileStore';

export type ResolveRegion = { base: string; yours: string; incoming: string; initial: string; conflict: boolean; changed: boolean };
type Change = { start: number; end: number; lines: string[] };

const lines = (text: string) => text.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [];

/** Line matches, with a bounded LCS for short ambiguous runs and unique-line anchors for long files. */
function matches(a: string[], b: string[]): [number, number][] {
  const out: [number, number][] = [];
  const visit = (as: number, ae: number, bs: number, be: number) => {
    while (as < ae && bs < be && a[as] === b[bs]) { out.push([as++, bs++]); }
    const tail: [number, number][] = [];
    while (as < ae && bs < be && a[ae - 1] === b[be - 1]) tail.unshift([--ae, --be]);
    if (as < ae && bs < be) {
      if ((ae - as) * (be - bs) <= 90_000) {
        const width = be - bs + 1;
        const table = new Uint32Array((ae - as + 1) * width);
        for (let i = ae - as - 1; i >= 0; i--) for (let j = be - bs - 1; j >= 0; j--)
          table[i * width + j] = a[as + i] === b[bs + j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
        let i = 0, j = 0;
        while (i < ae - as && j < be - bs) {
          if (a[as + i] === b[bs + j]) { out.push([as + i++, bs + j++]); }
          else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
          else j++;
        }
      } else {
        const ac = new Map<string, number>(), bc = new Map<string, number>();
        for (let i = as; i < ae; i++) ac.set(a[i], ac.has(a[i]) ? -1 : i);
        for (let i = bs; i < be; i++) bc.set(b[i], bc.has(b[i]) ? -1 : i);
        const candidates: [number, number][] = [];
        for (let i = as; i < ae; i++) { const j = bc.get(a[i]); if (ac.get(a[i]) === i && j !== undefined && j >= 0) candidates.push([i, j]); }
        const tails: number[] = [], prev = new Int32Array(candidates.length).fill(-1), at: number[] = [];
        candidates.forEach(([, j], k) => { let lo = 0, hi = tails.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < j) lo = mid + 1; else hi = mid; } if (lo) prev[k] = at[lo - 1]; tails[lo] = j; at[lo] = k; });
        const anchors: [number, number][] = [];
        for (let k = at[tails.length - 1]; k !== undefined && k >= 0; k = prev[k]) anchors.unshift(candidates[k]);
        let ai = as, bi = bs;
        for (const [i, j] of anchors) { visit(ai, i, bi, j); out.push([i, j]); ai = i + 1; bi = j + 1; }
        if (anchors.length) visit(ai, ae, bi, be);
      }
    }
    out.push(...tail);
  };
  visit(0, a.length, 0, b.length);
  return out;
}

function changes(base: string[], side: string[]): Change[] {
  const out: Change[] = [];
  let ai = 0, bi = 0;
  for (const [a, b] of [...matches(base, side), [base.length, side.length] as [number, number]]) {
    if (a !== ai || b !== bi) out.push({ start: ai, end: a, lines: side.slice(bi, b) });
    ai = a + 1; bi = b + 1;
  }
  return out;
}

/** A single ordered row for each unchanged span or changed region, shared by all columns. */
export function resolverRegions(data: Conflict): ResolveRegion[] {
  if (data.base === null || data.yours === null || data.incoming === null) return [];
  const base = lines(data.base), yours = changes(base, lines(data.yours)), incoming = changes(base, lines(data.incoming));
  const all = [...yours.map((change) => ({ ...change, side: 'yours' as const })), ...incoming.map((change) => ({ ...change, side: 'incoming' as const }))].sort((a, b) => a.start - b.start || a.end - b.end);
  const regions: ResolveRegion[] = [];
  let pos = 0, index = 0, block = 0;
  const render = (start: number, end: number, edits: Change[]) => {
    let cursor = start;
    const result: string[] = [];
    for (const edit of edits) { result.push(...base.slice(cursor, edit.start), ...edit.lines); cursor = edit.end; }
    result.push(...base.slice(cursor, end));
    return result.join('');
  };
  while (index < all.length) {
    const start = all[index].start;
    if (start > pos) { const text = base.slice(pos, start).join(''); regions.push({ base: text, yours: text, incoming: text, initial: text, conflict: false, changed: false }); }
    let end = all[index].end, last = index + 1;
    while (last < all.length && (all[last].start < end || (all[last].start === start && all[last].end === end) || (start === end && all[last].start === end))) end = Math.max(end, all[last++].end);
    const group = all.slice(index, last);
    const original = base.slice(start, end).join('');
    const left = render(start, end, group.filter((c) => c.side === 'yours'));
    const right = render(start, end, group.filter((c) => c.side === 'incoming'));
    const conflict = left !== right && left !== original && right !== original && block < data.blocks.length;
    // The backend's index-stage text is authoritative for the conflict itself.
    const actual = conflict ? data.blocks[block++] : null;
    const baseText = actual?.base ?? original, yoursText = actual?.yours ?? left, incomingText = actual?.incoming ?? right;
    regions.push({ base: baseText, yours: yoursText, incoming: incomingText,
      initial: conflict ? '' : left === original ? right : right === original ? left : left === right ? left : left,
      conflict, changed: true });
    pos = end; index = last;
  }
  if (pos < base.length) { const text = base.slice(pos).join(''); regions.push({ base: text, yours: text, incoming: text, initial: text, conflict: false, changed: false }); }
  return regions;
}
