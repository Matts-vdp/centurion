import type { KeyboardEvent } from 'react';

/** A list marker at the start of a line: `- `, `* ` or `1. `, with its indent. */
const MARKER = /^(\s*)(?:([-*])|(\d+)\.)\s+/;

/**
 * Continues a markdown list on a new line, like other editors: after `- item` the new line
 * starts with `- `, after `3. item` with `4. `. A new line on an empty item removes its marker
 * instead, which ends the list. Call it where the key would add a new line; it returns true
 * when it handled the key. The text stays plain markdown, and the edit goes through the
 * browser's own editing so Ctrl+Z undoes it and React's onChange fires.
 */
export function continueList(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
  if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.ctrlKey || e.metaKey || e.altKey) return false;
  const el = e.currentTarget;
  const { value, selectionStart: pos, selectionEnd } = el;
  if (pos !== selectionEnd) return false;
  const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
  const next = value.indexOf('\n', pos);
  const lineEnd = next === -1 ? value.length : next;
  const m = MARKER.exec(value.slice(lineStart, lineEnd));
  // The caret has to be after the marker: Enter before it just moves the line down.
  if (!m || pos < lineStart + m[0].length) return false;
  e.preventDefault();
  if (value.slice(lineStart + m[0].length, lineEnd).trim() === '') {
    el.setSelectionRange(lineStart, lineEnd);
    edit(el, '');
    return true;
  }
  const marker = m[2] ?? `${Number(m[3]) + 1}.`;
  edit(el, `\n${m[1]}${marker} `);
  return true;
}

/** Replaces the selection with `text`, keeping undo where the browser allows it. */
function edit(el: HTMLTextAreaElement, text: string) {
  el.focus();
  const ok = text ? document.execCommand('insertText', false, text) : document.execCommand('delete');
  if (ok) return;
  el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end');
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
