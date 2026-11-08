/**
 * A unified diff's hunks as data for the diff viewer (`DiffView.tsx`): lines with their numbers and their index
 * in `diff.split('\n')` (what partial staging sends), removed and added lines paired up for split view and word
 * highlights, and the gaps between hunks that more context can fill.
 */

export type LineKind = 'ctx' | 'add' | 'del';
/** A piece of a line; `changed` pieces get the stronger tint. */
export type Span = { text: string; changed: boolean };
export type DiffLine = {
  kind: LineKind;
  /** Index into `diff.split('\n')`. */
  n: number;
  text: string;
  old: number | null;
  new: number | null;
  /** Word highlights, when the line is paired with a similar one. */
  spans?: Span[];
};
export type Hunk = {
  index: number;
  /** The header's index in `diff.split('\n')`. */
  n: number;
  header: string;
  /** First and last line numbers on each side; with a count of 0, first is the line after and last the line before. */
  oldFirst: number;
  oldLast: number;
  newFirst: number;
  newLast: number;
  lines: DiffLine[];
};
/** A row of the split view: a line on either side, or one context line on both. */
export type SplitRow = { left: DiffLine | null; right: DiffLine | null };

/** Lines longer than this get no word highlights. */
const WORD_LIMIT = 500;

export function parseDiff(diff: string): Hunk[] {
  const all = diff.split('\n');
  const hunks: Hunk[] = [];
  let hunk: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  all.forEach((line, n) => {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      const [os, oc, ns, nc] = [m[1], m[2] ?? '1', m[3], m[4] ?? '1'].map(Number);
      hunk = {
        index: hunks.length,
        n,
        header: line,
        oldFirst: oc ? os : os + 1,
        oldLast: oc ? os + oc - 1 : os,
        newFirst: nc ? ns : ns + 1,
        newLast: nc ? ns + nc - 1 : ns,
        lines: [],
      };
      hunks.push(hunk);
      [oldLine, newLine] = [oc ? os : os + 1, nc ? ns : ns + 1];
      return;
    }
    if (!hunk || line.startsWith('\\')) return;
    if (line === '' && n === all.length - 1) return;
    const kind: LineKind = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx';
    hunk.lines.push({ kind, n, text: line.slice(1), old: kind !== 'add' ? oldLine : null, new: kind !== 'del' ? newLine : null });
    if (kind !== 'add') oldLine++;
    if (kind !== 'del') newLine++;
  });
  for (const h of hunks) addWordSpans(h.lines);
  return hunks;
}

/** Runs of removed lines followed by added lines, paired up by position. */
function runs(lines: DiffLine[]): { del: DiffLine[]; add: DiffLine[] }[] {
  const out: { del: DiffLine[]; add: DiffLine[] }[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind === 'ctx') {
      i++;
      continue;
    }
    const run = { del: [] as DiffLine[], add: [] as DiffLine[] };
    while (i < lines.length && lines[i].kind === 'del') run.del.push(lines[i++]);
    while (i < lines.length && lines[i].kind === 'add') run.add.push(lines[i++]);
    out.push(run);
  }
  return out;
}

export function addWordSpans(lines: DiffLine[]): void {
  for (const run of runs(lines)) {
    const pairs = Math.min(run.del.length, run.add.length);
    for (let k = 0; k < pairs; k++) {
      const spans = wordDiff(run.del[k].text, run.add[k].text);
      if (spans) [run.del[k].spans, run.add[k].spans] = spans;
    }
  }
}

/** The split view's rows: context on both sides, removed and added runs side by side, filler on the shorter side. */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.kind === 'ctx') {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    const del: DiffLine[] = [];
    const add: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === 'del') del.push(lines[i++]);
    while (i < lines.length && lines[i].kind === 'add') add.push(lines[i++]);
    for (let k = 0; k < Math.max(del.length, add.length); k++) rows.push({ left: del[k] ?? null, right: add[k] ?? null });
  }
  return rows;
}

// ---------- word diff ----------

const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;

/**
 * The changed words of a removed and an added line, from a longest common subsequence of their tokens
 * (words, runs of spaces, single symbols). Null when a line is too long or the two share too little to be worth
 * marking (then the whole line is the change).
 */
export function wordDiff(a: string, b: string): [Span[], Span[]] | null {
  if (a.length > WORD_LIMIT || b.length > WORD_LIMIT || a === b) return null;
  const x = a.match(TOKEN) ?? [];
  const y = b.match(TOKEN) ?? [];
  // Common ends first, so the table only covers the middle.
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let endX = x.length;
  let endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) {
    endX--;
    endY--;
  }
  const mx = x.slice(start, endX);
  const my = y.slice(start, endY);
  const keepX = new Array<boolean>(mx.length).fill(false);
  const keepY = new Array<boolean>(my.length).fill(false);
  if (mx.length && my.length) {
    const w = my.length + 1;
    const table = new Uint16Array((mx.length + 1) * w);
    for (let i = mx.length - 1; i >= 0; i--) {
      for (let j = my.length - 1; j >= 0; j--) {
        table[i * w + j] = mx[i] === my[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < mx.length && j < my.length) {
      if (mx[i] === my[j]) {
        keepX[i++] = true;
        keepY[j++] = true;
      } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) i++;
      else j++;
    }
  }
  const same = (tokens: string[], keep: boolean[]) =>
    tokens.slice(0, start).join('').length + tokens.slice(start + keep.length).join('').length + keep.reduce((s, k, i) => s + (k ? tokens[start + i].length : 0), 0);
  const common = same(x, keepX);
  // Mostly different lines read better as a plain change than as confetti.
  if (common < 0.4 * Math.max(a.length, b.length) || common === Math.max(a.length, b.length)) return null;
  return [spansOf(x, start, keepX), spansOf(y, start, keepY)];
}

function spansOf(tokens: string[], start: number, keep: boolean[]): Span[] {
  const changed = tokens.map((_, i) => i >= start && i < start + keep.length && !keep[i - start]);
  // A space between two changed words belongs to the change, so it reads as one phrase.
  for (let i = 1; i < tokens.length - 1; i++) if (!changed[i] && /^\s+$/.test(tokens[i]) && changed[i - 1] && changed[i + 1]) changed[i] = true;
  const spans: Span[] = [];
  tokens.forEach((t, i) => {
    const last = spans[spans.length - 1];
    if (last && last.changed === changed[i]) last.text += t;
    else spans.push({ text: t, changed: changed[i] });
  });
  return spans;
}

// ---------- context between hunks ----------

/**
 * The lines between hunks, on the new side: gap `k` is before hunk `k`, gap `hunks.length` after the last one
 * (its end is unknown until the text is loaded: `Infinity`). `delta` turns a new-side number into the old side's.
 */
export type Gap = { first: number; last: number; delta: number };

export function gapsOf(hunks: Hunk[]): Gap[] {
  const gaps: Gap[] = hunks.map((h, k) => {
    const prev = hunks[k - 1];
    return { first: prev ? prev.newLast + 1 : 1, last: h.newFirst - 1, delta: h.oldFirst - h.newFirst };
  });
  const lastHunk = hunks[hunks.length - 1];
  if (lastHunk) gaps.push({ first: lastHunk.newLast + 1, last: Infinity, delta: lastHunk.oldLast - lastHunk.newLast });
  return gaps;
}

/** Context lines `from`..`to` (new-side numbers, inclusive) of a gap, from the new side's text lines. */
export function contextLines(text: string[], gap: Gap, from: number, to: number): DiffLine[] {
  const out: DiffLine[] = [];
  for (let line = Math.max(from, gap.first); line <= Math.min(to, gap.last, text.length); line++) {
    out.push({ kind: 'ctx', n: -1, text: text[line - 1], old: line + gap.delta, new: line });
  }
  return out;
}
