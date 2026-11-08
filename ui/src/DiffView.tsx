import { Fragment, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react';
import { contextLines, gapsOf, splitRows, type DiffLine, type Gap, type Hunk, type Span } from './diffModel';
import { formatSize, type ApplyAction, type FileDiff } from './fileStore';
import { ChevronDownIcon, ChevronUpIcon, CloseIcon } from './icons';

/**
 * The Files viewer's diff (`docs/git-plan.md` §4): unified or split, word highlights, more context around hunks,
 * and staging, unstaging or discarding hunks and selected lines.
 */

/** Lines a click on a hunk's arrows adds. */
const MORE = 20;

/** What can be done from this diff: the side partial staging works on, or why it can't. */
export type DiffActions = { side: 'worktree' | 'staged' } | { disabled: string } | null;

type Props = {
  diff: FileDiff;
  hunks: Hunk[];
  layout: 'unified' | 'split';
  actions: DiffActions;
  /** An untracked file: discarding deletes it. */
  untracked: boolean;
  name: string;
  /** Which side the diff is, for its empty message. */
  emptyText: string;
  /** The context the diff was made with (git's default 3 when unset). */
  context?: number;
  /** The new side's lines, for more context; null when they can't be read. */
  loadText: () => Promise<string[] | null>;
  /** Resolves when the write is done (true) or failed (false); the parent refreshes the diff. */
  onApply: (action: ApplyAction, hunks: number[], lines: number[]) => Promise<boolean>;
  /** A binary file: stage or unstage it whole. */
  onFile: (action: 'stage' | 'unstage') => Promise<boolean>;
};

type Expand = { top: number; bottom: number };

export function DiffView({ diff, hunks, layout, actions, untracked, name, emptyText, context = 3, loadText, onApply, onFile }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const anchor = useRef<number | null>(null);
  const [confirm, setConfirm] = useState<number | 'lines' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expand, setExpand] = useState<Map<number, Expand>>(new Map());
  const [text, setText] = useState<string[] | null>(null);
  const [textError, setTextError] = useState('');
  const pending = useRef<Promise<string[] | null> | null>(null);

  const side = actions && 'side' in actions ? actions.side : null;
  const disabledWhy = actions && 'disabled' in actions ? actions.disabled : null;
  const canSelect = side !== null && busy === null;

  // Esc clears a line selection before it closes the file.
  useEffect(() => {
    if (selected.size === 0 && confirm === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const panel = ref.current?.closest('.files-panel');
      if (!panel || !panel.contains(document.activeElement)) return;
      e.stopPropagation();
      e.preventDefault();
      if (confirm !== null) setConfirm(null);
      else setSelected(new Set());
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [selected, confirm]);

  if (diff.binary) return <BinaryLine diff={diff} side={side} disabledWhy={disabledWhy} onFile={onFile} />;
  if (!diff.diff.trim() || hunks.length === 0) return <p className="files-note">{emptyText}</p>;

  const run = async (key: string, call: () => Promise<boolean>) => {
    setBusy(key);
    setConfirm(null);
    try {
      if (await call()) setSelected(new Set());
    } finally {
      setBusy(null);
    }
  };
  const applyHunk = (k: number, action: ApplyAction) => void run(`${action}:${k}`, () => onApply(action, [k], []));
  const applyLines = (action: ApplyAction) => void run(`${action}:lines`, () => onApply(action, [], [...selected].sort((a, b) => a - b)));

  // ---------- line selection ----------
  const changeLines = hunks.flatMap((h) => h.lines.filter((l) => l.kind !== 'ctx'));
  const select = (line: DiffLine, e: ReactMouseEvent) => {
    if (!canSelect || line.kind === 'ctx') return;
    setConfirm((c) => (c === 'lines' ? null : c));
    const next = new Set(selected);
    if (e.shiftKey && anchor.current !== null) {
      const [from, to] = [Math.min(anchor.current, line.n), Math.max(anchor.current, line.n)];
      for (const l of changeLines) if (l.n >= from && l.n <= to) next.add(l.n);
    } else if (next.has(line.n)) next.delete(line.n);
    else next.add(line.n);
    anchor.current = line.n;
    setSelected(next);
  };

  // ---------- more context ----------
  const gaps = gapsOf(hunks);
  // The last hunk reaches the end of the file when it has less trailing context than git was asked for.
  const lastLines = hunks[hunks.length - 1].lines;
  let trailing = 0;
  while (trailing < lastLines.length && lastLines[lastLines.length - 1 - trailing].kind === 'ctx') trailing++;
  const wholeFile = diff.status === 'U' || diff.status === 'A' || diff.status === 'D' || trailing < context;
  const sizeOf = (k: number): number => {
    const g = gaps[k];
    const last = g.last === Infinity ? (text ? text.length : Infinity) : g.last;
    return Math.max(0, last - g.first + 1);
  };
  const hiddenOf = (k: number): number => {
    const e = expand.get(k) ?? { top: 0, bottom: 0 };
    return Math.max(0, sizeOf(k) - e.top - e.bottom);
  };
  const more = async (k: number, dir: 'top' | 'bottom') => {
    let lines = text;
    if (!lines) {
      setTextError('');
      pending.current ??= loadText();
      try {
        lines = await pending.current;
      } catch (err) {
        lines = null;
        setTextError(err instanceof Error ? err.message : String(err));
      }
      pending.current = null;
      if (!lines) {
        setTextError((e) => e || "The file's text can't be shown here");
        return;
      }
      setText(lines);
    }
    setExpand((m) => {
      const e = m.get(k) ?? { top: 0, bottom: 0 };
      return new Map(m).set(k, dir === 'top' ? { ...e, top: e.top + MORE } : { ...e, bottom: e.bottom + MORE });
    });
  };
  /** The revealed lines of gap `k`: those after the previous hunk, and those before hunk `k`. */
  const revealed = (k: number): { top: DiffLine[]; bottom: DiffLine[] } => {
    const e = expand.get(k);
    if (!e || !text) return { top: [], bottom: [] };
    const g: Gap = gaps[k];
    const size = sizeOf(k);
    if (e.top + e.bottom >= size) return { top: contextLines(text, g, g.first, g.first + size - 1), bottom: [] };
    const last = g.first + size - 1;
    return { top: contextLines(text, g, g.first, g.first + e.top - 1), bottom: contextLines(text, g, last - e.bottom + 1, last) };
  };

  // ---------- rendering ----------
  const split = layout === 'split';
  const lineRows = (lines: DiffLine[], key: string): ReactNode[] =>
    split
      ? splitRows(lines).map((row, i) => <SplitLine key={`${key}${i}`} row={row} selected={selected} canSelect={canSelect} onSelect={select} />)
      : lines.map((l, i) => <UnifiedLine key={`${key}${i}`} line={l} selected={selected.has(l.n)} canSelect={canSelect} onSelect={select} />);

  const hunkButtons = (h: Hunk): ReactNode => {
    if (!side && !disabledWhy) return null;
    const title = disabledWhy ?? undefined;
    const label = (action: ApplyAction, idle: string, doing: string) => (busy === `${action}:${h.index}` ? doing : idle);
    return (
      <span className="diff-hunk-actions">
        {side !== 'staged' && (
          <button className="diff-hunk-button" disabled={!side || busy !== null} title={title ?? (untracked ? 'Delete the file…' : 'Discard this change…')} onClick={() => setConfirm(h.index)}>
            {label('discard', untracked ? 'Delete' : 'Discard', 'Discarding…')}
          </button>
        )}
        {side !== 'staged' ? (
          <button className="diff-hunk-button" disabled={!side || busy !== null} title={title ?? 'Stage this change'} onClick={() => applyHunk(h.index, 'stage')}>
            {label('stage', 'Stage', 'Staging…')}
          </button>
        ) : (
          <button className="diff-hunk-button" disabled={busy !== null} title="Unstage this change" onClick={() => applyHunk(h.index, 'unstage')}>
            {label('unstage', 'Unstage', 'Unstaging…')}
          </button>
        )}
      </span>
    );
  };

  const rows: ReactNode[] = [];
  hunks.forEach((h, k) => {
    const { top, bottom } = revealed(k);
    rows.push(...lineRows(top, `g${k}t`));
    const hidden = hiddenOf(k);
    rows.push(
      <div key={`h${k}`} className="diff-line hunk" data-hunk={k}>
        <span className="diff-expand">
          {hidden > 0 && k > 0 && (
            <button className="diff-arrow" title={`Show ${Math.min(MORE, hidden)} more lines below the previous change`} aria-label="Show more lines below the previous change" onClick={() => void more(k, 'top')}>
              <ChevronDownIcon size={13} />
            </button>
          )}
          {hidden > 0 && (
            <button className="diff-arrow" title={`Show ${Math.min(MORE, hidden)} more lines above this change`} aria-label="Show more lines above this change" onClick={() => void more(k, 'bottom')}>
              <ChevronUpIcon size={13} />
            </button>
          )}
        </span>
        <span className="diff-hunk-text" title={hidden > 0 && hidden !== Infinity ? `${hidden} unchanged line${hidden === 1 ? '' : 's'} hidden above` : undefined}>
          {h.header}
        </span>
        {hunkButtons(h)}
      </div>,
    );
    if (confirm === h.index) {
      rows.push(
        <Confirm
          key={`c${k}`}
          text={untracked ? `Delete ${name}? It isn't in git, so this can't be undone.` : "Discard this change? This can't be undone."}
          verb={untracked ? 'Delete' : 'Discard'}
          onCancel={() => setConfirm(null)}
          onConfirm={() => applyHunk(h.index, 'discard')}
        />,
      );
    }
    rows.push(...lineRows(bottom, `g${k}b`));
    rows.push(...lineRows(h.lines, `l${k}:`));
  });
  // After the last hunk: the rest of the file, 20 lines at a time.
  const end = hunks.length;
  if (!wholeFile && !diff.truncated) {
    const { top } = revealed(end);
    rows.push(...lineRows(top, 'gend'));
    if (hiddenOf(end) > 0) {
      rows.push(
        <div key="end" className="diff-line hunk diff-end">
          <span className="diff-expand">
            <button className="diff-arrow" title={`Show ${MORE} more lines`} aria-label="Show more lines below the last change" onClick={() => void more(end, 'top')}>
              <ChevronDownIcon size={13} />
            </button>
          </span>
          <span className="diff-hunk-text">{textError || (text ? `${hiddenOf(end)} more unchanged lines` : '')}</span>
        </div>,
      );
    }
  }

  const count = selected.size;
  const lines = `${count} line${count === 1 ? '' : 's'}`;
  return (
    <div ref={ref} className={`diff-wrap${count > 0 && side ? ' selecting' : ''}`}>
      {diff.truncated && <p className="files-note">The diff is cut off at 1 MB.</p>}
      {textError && hiddenOf(end) === 0 && <p className="files-note error">{textError}</p>}
      <div className={`diff viewer-diff${split ? ' split' : ''}${canSelect ? ' selectable' : ''}`}>{rows}</div>
      {count > 0 && side && (
        <div className="diff-select-anchor">
          <div className="diff-select-bar" role="toolbar" aria-label="Selected lines">
            {confirm === 'lines' ? (
              <>
                <span>Discard {lines}? This can't be undone.</span>
                <button className="button secondary small" onClick={() => setConfirm(null)}>
                  Cancel
                </button>
                <button className="button secondary small danger" autoFocus onClick={() => applyLines('discard')}>
                  Discard
                </button>
              </>
            ) : (
              <>
                {side === 'worktree' && (
                  <button className="button secondary small danger" disabled={busy !== null} onClick={() => setConfirm('lines')}>
                    {busy === 'discard:lines' ? 'Discarding…' : `Discard ${lines}…`}
                  </button>
                )}
                {side === 'worktree' ? (
                  <button className="button primary small" disabled={busy !== null} onClick={() => applyLines('stage')}>
                    {busy === 'stage:lines' ? 'Staging…' : `Stage ${lines}`}
                  </button>
                ) : (
                  <button className="button primary small" disabled={busy !== null} onClick={() => applyLines('unstage')}>
                    {busy === 'unstage:lines' ? 'Unstaging…' : `Unstage ${lines}`}
                  </button>
                )}
                <button className="icon-button small" title="Clear the selection (Esc)" aria-label="Clear the selection" onClick={() => setSelected(new Set())}>
                  <CloseIcon size={14} />
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Confirm({ text, verb, onCancel, onConfirm }: { text: string; verb: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="rewind-confirm diff-confirm" role="group" aria-label={verb}>
      <span>{text}</span>
      <button className="button secondary small" onClick={onCancel}>
        Cancel
      </button>
      <button className="button secondary small danger" autoFocus onClick={onConfirm}>
        {verb}
      </button>
    </div>
  );
}

function Words({ line }: { line: DiffLine }) {
  if (!line.spans) return <>{line.text || ' '}</>;
  return (
    <>
      {line.spans.map((s: Span, i) =>
        s.changed ? (
          <span key={i} className="diff-word">
            {s.text}
          </span>
        ) : (
          <Fragment key={i}>{s.text}</Fragment>
        ),
      )}
    </>
  );
}

const SIGN = { add: '+', del: '−', ctx: ' ' } as const;

/** The line numbers; a button that selects the line when it is a change that can be staged. */
function Numbers({ line, nums, canSelect, onSelect }: { line: DiffLine; nums: (number | null)[]; canSelect: boolean; onSelect: (l: DiffLine, e: ReactMouseEvent) => void }) {
  const cells = nums.map((n, i) => (
    <span key={i} className="diff-num">
      {n ?? ''}
    </span>
  ));
  if (!canSelect || line.kind === 'ctx') return <span className="diff-nums">{cells}</span>;
  return (
    <button className="diff-nums" tabIndex={-1} title="Select this line (Shift+click selects a range)" aria-label={`Select line ${line.new ?? line.old}`} onClick={(e) => onSelect(line, e)}>
      {cells}
    </button>
  );
}

function UnifiedLine({ line, selected, canSelect, onSelect }: { line: DiffLine; selected: boolean; canSelect: boolean; onSelect: (l: DiffLine, e: ReactMouseEvent) => void }) {
  return (
    <div className={`diff-line ${line.kind}${selected ? ' selected' : ''}${line.n < 0 ? ' more' : ''}`}>
      <Numbers line={line} nums={[line.old, line.new]} canSelect={canSelect} onSelect={onSelect} />
      <span className="diff-sign">{SIGN[line.kind]}</span>
      <span className="diff-text">
        <Words line={line} />
      </span>
    </div>
  );
}

function SplitLine({
  row,
  selected,
  canSelect,
  onSelect,
}: {
  row: { left: DiffLine | null; right: DiffLine | null };
  selected: Set<number>;
  canSelect: boolean;
  onSelect: (l: DiffLine, e: ReactMouseEvent) => void;
}) {
  const half = (line: DiffLine | null, which: 'old' | 'new') => {
    if (!line) return <div className="diff-half empty" />;
    const kind = line.kind;
    return (
      <div className={`diff-half ${kind}${selected.has(line.n) && kind !== 'ctx' ? ' selected' : ''}${line.n < 0 ? ' more' : ''}`}>
        <Numbers line={line} nums={[line[which]]} canSelect={canSelect} onSelect={onSelect} />
        <span className="diff-sign">{SIGN[kind]}</span>
        <span className="diff-text">
          <Words line={line} />
        </span>
      </div>
    );
  };
  return (
    <div className="diff-row">
      {half(row.left, 'old')}
      {half(row.right, 'new')}
    </div>
  );
}

function BinaryLine({
  diff,
  side,
  disabledWhy,
  onFile,
}: {
  diff: FileDiff;
  side: 'worktree' | 'staged' | null;
  disabledWhy: string | null;
  onFile: (action: 'stage' | 'unstage') => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const s = diff.sizes;
  const text = !s
    ? 'Binary file changed'
    : s.old === null && s.new !== null
      ? `Binary file added · ${formatSize(s.new)}`
      : s.new === null && s.old !== null
        ? `Binary file deleted · ${formatSize(s.old)}`
        : s.old !== null && s.new !== null
          ? `Binary file changed · ${formatSize(s.old)} → ${formatSize(s.new)}`
          : 'Binary file changed';
  const action = side === 'staged' ? 'unstage' : 'stage';
  return (
    <div className="diff-binary">
      <span>{text}</span>
      {(side || disabledWhy) && (
        <button
          className="button secondary small"
          disabled={busy || !side}
          title={side ? undefined : (disabledWhy ?? undefined)}
          onClick={async () => {
            setBusy(true);
            try {
              await onFile(action);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? (action === 'stage' ? 'Staging…' : 'Unstaging…') : action === 'stage' ? 'Stage file' : 'Unstage file'}
        </button>
      )}
    </div>
  );
}

// ---------- moving between hunks ----------

/**
 * Where the diff in `body` is: the hunk at the top of the view (from 0) and how many there are, with jumps to the
 * next and previous hunk header (`[data-hunk]`).
 */
export function useHunkNav(body: RefObject<HTMLElement | null>, total: number, key: string) {
  const [current, setCurrent] = useState(0);
  const locate = () => {
    const el = body.current;
    if (!el) return [] as { k: number; top: number }[];
    const base = el.getBoundingClientRect().top - el.scrollTop;
    return [...el.querySelectorAll<HTMLElement>('[data-hunk]')].map((h) => ({ k: Number(h.dataset.hunk), top: h.getBoundingClientRect().top - base }));
  };
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const list = locate();
      const at = el.scrollTop + 8;
      let k = 0;
      for (const h of list) if (h.top <= at) k = h.k;
      // At the very bottom, the last hunk counts as reached.
      if (list.length && el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 2) k = list[list.length - 1].k;
      setCurrent(k);
    };
    const onScroll = () => (frame ||= requestAnimationFrame(update));
    update();
    el.addEventListener('scroll', onScroll);
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [body, key, total]);
  const go = (dir: 1 | -1) => {
    const el = body.current;
    if (!el || total === 0) return;
    const list = locate();
    const at = el.scrollTop;
    const target = dir === 1 ? list.find((h) => h.top > at + 9) : [...list].reverse().find((h) => h.top < at - 1);
    if (!target) return;
    el.scrollTo({ top: Math.max(0, target.top - 4) });
    setCurrent(target.k);
  };
  return { current, next: () => go(1), prev: () => go(-1) };
}
