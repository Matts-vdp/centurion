import type { KeyboardEvent } from 'react';

/** A list marker at the start of a line: `- `, `* ` or `1. `, with its indent. */
const MARKER = /^(\s*)(?:([-*])|(\d+)\.)\s+/;

type Item = { indent: number; bullet: string | null; number: number | null; marker: string; rest: string };

function parse(line: string): Item | null {
  const m = MARKER.exec(line);
  if (!m) return null;
  return { indent: m[1].length, bullet: m[2] ?? null, number: m[3] ? Number(m[3]) : null, marker: m[0].slice(m[1].length), rest: line.slice(m[0].length) };
}

function render(it: Item): string {
  return `${' '.repeat(it.indent)}${it.marker}${it.rest}`;
}

/** The marker with a new number, keeping the spacing after it. */
function numbered(it: Item, n: number): string {
  return `${n}.${it.marker.slice(String(it.number).length + 1)}`;
}

/**
 * Continues a markdown list on a new line, like other editors: after `- item` the new line
 * starts with `- `, after `3. item` with `4. ` (and the items after it are renumbered). A new
 * line on an empty item ends the list: a nested item moves out one level, a top-level one loses
 * its marker. Call it where the key would add a new line; it returns true when it handled the
 * key. The text stays plain markdown, and the edit goes through the browser's own editing so
 * Ctrl+Z undoes it and React's onChange fires.
 */
export function continueList(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
  if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.ctrlKey || e.metaKey || e.altKey) return false;
  const el = e.currentTarget;
  const { value, selectionStart: pos, selectionEnd } = el;
  if (pos !== selectionEnd) return false;
  const lines = value.split('\n');
  const row = rowAt(value, pos);
  const lineStart = pos - colAt(value, pos);
  const it = parse(lines[row]);
  // The caret has to be after the marker: Enter before it just moves the line down.
  if (!it || pos < lineStart + it.indent + it.marker.length) return false;
  e.preventDefault();
  if (it.rest.trim() === '') {
    if (it.indent > 0) {
      shift(el, row, row, -1);
      return true;
    }
    el.setSelectionRange(lineStart, lineStart + lines[row].length);
    edit(el, '');
    return true;
  }
  const marker = it.bullet !== null ? it.marker : numbered(it, it.number! + 1);
  const col = pos - lineStart;
  const head = lines[row].slice(0, col);
  const tail = lines[row].slice(col);
  const next = lines.slice(0, row).concat(head, `${' '.repeat(it.indent)}${marker}${tail.replace(/^\s+/, '')}`, lines.slice(row + 1));
  const caret = { row: row + 1, col: it.indent + marker.length };
  replaceLines(el, lines, renumber(next, row + 1), caret, caret);
  return true;
}

/**
 * Tab and Shift+Tab on list items indent and outdent the item under the caret, or every item in
 * a multi-line selection; ordered lists are renumbered per level. Returns true when it handled
 * the key (false off a list, so Tab still moves the focus there).
 */
export function indentList(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
  if (e.key !== 'Tab' || e.nativeEvent.isComposing || e.ctrlKey || e.metaKey || e.altKey) return false;
  const el = e.currentTarget;
  const first = rowAt(el.value, el.selectionStart);
  // A selection that ends at the very start of a line doesn't take that line.
  let last = rowAt(el.value, el.selectionEnd);
  if (last > first && colAt(el.value, el.selectionEnd) === 0) last--;
  const lines = el.value.split('\n');
  if (!lines.slice(first, last + 1).some((l) => parse(l))) return false;
  e.preventDefault();
  shift(el, first, last, e.shiftKey ? -1 : 1);
  return true;
}

/** Moves the items of rows `first`..`last` one level in (1) or out (-1), then renumbers. */
function shift(el: HTMLTextAreaElement, first: number, last: number, dir: 1 | -1): void {
  const lines = el.value.split('\n');
  const next = [...lines];
  const deltas = new Map<number, number>();
  // Siblings in the selection move together: the first one decides by how much.
  const groups = new Map<string, number>();
  for (let r = first; r <= last; r++) {
    const it = parse(lines[r]);
    if (!it) continue;
    // An item whose parent moves too keeps its place under it; the others move one level.
    const parent = parentRow(lines, r, it.indent);
    const group = `${parent ?? -1}:${it.indent}`;
    const delta =
      parent !== null && deltas.has(parent)
        ? deltas.get(parent)!
        : (groups.get(group) ?? (dir > 0 ? childIndent(lines, r, it.indent) : parentIndent(lines, r, it.indent) - it.indent));
    groups.set(group, delta);
    const indent = Math.max(0, it.indent + delta);
    if (indent === it.indent) continue;
    deltas.set(r, indent - it.indent);
    next[r] = render({ ...it, indent });
  }
  const at = (p: number) => {
    const row = rowAt(el.value, p);
    const col = colAt(el.value, p);
    const d = deltas.get(row) ?? 0;
    return { row, col: Math.max(0, col + d) };
  };
  replaceLines(el, lines, renumber(next, first, new Set(deltas.keys())), at(el.selectionStart), at(el.selectionEnd));
}

/** How far an item moves in: under the item above it at its level, past that item's marker. */
function childIndent(lines: string[], row: number, indent: number): number {
  for (let r = row - 1; r >= 0; r--) {
    const it = parse(lines[r]);
    if (!it) {
      if (!lines[r].trim()) break;
      continue;
    }
    if (it.indent === indent) return it.marker.length;
    if (it.indent < indent) break;
  }
  return 2;
}

/** The row of an item's parent: the nearest item above with less indent, within the list. */
function parentRow(lines: string[], row: number, indent: number): number | null {
  if (indent === 0) return null;
  for (let r = row - 1; r >= 0; r--) {
    const it = parse(lines[r]);
    if (!it) {
      if (!lines[r].trim()) break;
      continue;
    }
    if (it.indent < indent) return r;
  }
  return null;
}

/** Where an item moves out to: its parent's indent. */
function parentIndent(lines: string[], row: number, indent: number): number {
  const p = parentRow(lines, row, indent);
  return p === null ? Math.max(0, indent - 2) : parse(lines[p])!.indent;
}

/**
 * Renumbers the ordered items of the list around `row`, per level: each run of numbered siblings
 * counts up from its first number, and a run that starts on a `moved` row (it just became a new
 * level) starts at 1.
 */
function renumber(lines: string[], row: number, moved: Set<number> = new Set()): string[] {
  let start = row;
  while (start > 0 && lines[start - 1].trim() && (parse(lines[start - 1]) || /^\s/.test(lines[start - 1]))) start--;
  const out = [...lines];
  const stack: { indent: number; next: number | null }[] = [];
  for (let r = start; r < out.length; r++) {
    const it = parse(out[r]);
    if (!it) {
      if (!out[r].trim() || !/^\s/.test(out[r])) break;
      continue;
    }
    while (stack.length && stack.at(-1)!.indent > it.indent) stack.pop();
    const top = stack.at(-1);
    if (top && top.indent === it.indent) {
      if (it.number === null) top.next = null;
      else if (top.next === null) top.next = it.number + 1;
      else {
        out[r] = render({ ...it, marker: numbered(it, top.next) });
        top.next++;
      }
    } else {
      const n = it.number === null ? null : moved.has(r) ? 1 : it.number;
      if (it.number !== null && n !== it.number) out[r] = render({ ...it, marker: numbered(it, n!) });
      stack.push({ indent: it.indent, next: n === null ? null : n + 1 });
    }
  }
  return out;
}

/** Replaces the changed rows in one edit (one undo step) and puts the selection back. */
function replaceLines(el: HTMLTextAreaElement, before: string[], after: string[], selStart: { row: number; col: number }, selEnd: { row: number; col: number }): void {
  const old = before.join('\n');
  const text = after.join('\n');
  let a = 0;
  while (a < old.length && a < text.length && old[a] === text[a]) a++;
  let b = 0;
  while (b < old.length - a && b < text.length - a && old[old.length - 1 - b] === text[text.length - 1 - b]) b++;
  if (old !== text) {
    el.setSelectionRange(a, old.length - b);
    edit(el, text.slice(a, text.length - b));
  }
  const offset = (row: number) => after.slice(0, row).reduce((n, l) => n + l.length + 1, 0);
  const pos = (s: { row: number; col: number }) => offset(s.row) + Math.min(s.col, after[s.row]?.length ?? 0);
  el.setSelectionRange(pos(selStart), pos(selEnd));
}

function rowAt(value: string, pos: number): number {
  let n = 0;
  for (let i = value.indexOf('\n'); i !== -1 && i < pos; i = value.indexOf('\n', i + 1)) n++;
  return n;
}

function colAt(value: string, pos: number): number {
  return pos - (value.lastIndexOf('\n', pos - 1) + 1);
}

/** Replaces the selection with `text`, keeping undo where the browser allows it. */
function edit(el: HTMLTextAreaElement, text: string) {
  el.focus();
  const ok = text ? document.execCommand('insertText', false, text) : document.execCommand('delete');
  if (ok) return;
  el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end');
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
