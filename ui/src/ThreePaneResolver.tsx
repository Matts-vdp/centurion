import { useEffect, useMemo, useRef, useState } from 'react';
import { gitApi, gitFailure, type Conflict, type GitStatus } from './fileStore';
import { highlight, languageOf } from './highlight';
import { wordDiff } from './diffModel';
import { resolverRegions } from './resolverModel';

type Props = { agentId: string; path: string; version: number; onClose: () => void; onInline: () => void; onApplied: (status: GitStatus | null) => void; onError: (message: string) => void };

function Code({ text, path, before, kind }: { text: string; path: string; before?: string; kind?: 'add' | 'del' }) {
  const line = text.replace(/\r?\n$/, '');
  const previous = before?.replace(/\r?\n$/, '');
  const spans = previous !== undefined && !line.includes('\n') && !previous.includes('\n') ? wordDiff(previous, line)?.[1] : null;
  if (spans) return <pre className="resolver-code">{spans.map((s, i) => <span key={i} className={s.changed ? `resolver-word ${kind ?? 'add'}` : undefined}>{s.text}</span>)}{text.slice(line.length)}</pre>;
  const html = highlight(text, languageOf(path));
  return <pre className="resolver-code">{html === null ? text || '\u00a0' : <code dangerouslySetInnerHTML={{ __html: html || '&nbsp;' }} />}</pre>;
}

export function ThreePaneResolver({ agentId, path, version, onClose, onInline, onApplied, onError }: Props) {
  const [data, setData] = useState<Conflict | null>(null);
  const [values, setValues] = useState<(string | null)[]>([]);
  const [ignored, setIgnored] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [base, setBase] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [active, setActive] = useState(-1);
  const scroll = useRef<HTMLDivElement>(null);
  const hash = useRef<string | null>(null);
  const inline = useRef(onInline);
  inline.current = onInline;
  const regions = useMemo(() => data ? resolverRegions(data) : [], [data]);
  const conflicts = useMemo(() => regions.map((r, i) => r.conflict ? i : -1).filter((i) => i >= 0), [regions]);
  const remaining = conflicts.filter((i) => values[i] === null).length;

  useEffect(() => {
    let cancelled = false;
    setError('');
    void gitApi.conflict(agentId, path).then((next) => {
      if (cancelled) return;
      if (next.binary || next.deleted || next.base === null || next.yours === null || next.incoming === null || !next.blocks.length) { inline.current(); return; }
      const model = resolverRegions(next);
      if (hash.current !== next.hash) {
        setValues(model.map((r) => r.conflict ? null : r.initial));
        setIgnored(new Set()); setEditing(null); setActive(-1); hash.current = next.hash;
      }
      setData(next);
    }).catch((e) => !cancelled && setError(gitFailure(e).error));
    return () => { cancelled = true; };
  }, [agentId, path, version]);

  const choose = (i: number, value: string) => { setValues((old) => old.map((v, n) => n === i ? value : v)); setEditing(null); };
  const toggleIgnore = (i: number) => {
    setIgnored((old) => { const next = new Set(old); if (next.has(i)) next.delete(i); else next.add(i); return next; });
    setValues((old) => old.map((v, n) => n === i ? (ignored.has(i) ? regions[i].initial : regions[i].base) : v));
  };
  const go = (direction: number) => {
    if (!conflicts.length) return;
    const current = conflicts.indexOf(active);
    const next = conflicts[current < 0 ? direction > 0 ? 0 : conflicts.length - 1 : (current + direction + conflicts.length) % conflicts.length];
    setActive(next);
    scroll.current?.querySelector(`[data-region="${next}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  useEffect(() => {
    const onKey = (event: Event) => {
      const e = event as KeyboardEvent;
      if (!e.altKey || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
      e.preventDefault(); e.stopPropagation(); go(e.key === 'ArrowDown' ? 1 : -1);
    };
    const panel = scroll.current?.closest('.files-panel');
    panel?.addEventListener('keydown', onKey);
    return () => panel?.removeEventListener('keydown', onKey);
  });

  const apply = async () => {
    if (!data || remaining || values.some((v) => v === null)) return;
    // Compare the model with Git's working merge before writing. A rare ambiguous line
    // alignment can be handled in the inline resolver without losing Git's auto merge.
    let baseline = data.merged ?? '';
    for (let i = data.blocks.length - 1; i >= 0; i--) baseline = baseline.slice(0, data.blocks[i].start) + baseline.slice(data.blocks[i].end);
    const modelBaseline = regions.map((r) => r.conflict ? '' : r.initial).join('');
    if (baseline !== modelBaseline || conflicts.length !== data.blocks.length) {
      setError('This file has an ambiguous merge layout. Open its inline view to keep Git’s merged text.');
      return;
    }
    setBusy(true); setError('');
    try {
      const r = await gitApi.resolve(agentId, { path: data.path, content: values.join(''), hash: data.hash });
      onApplied(r.status);
    } catch (e) { const message = gitFailure(e).error; setError(message); onError(message); }
    finally { setBusy(false); }
  };
  const revert = () => { setValues(regions.map((r) => r.conflict ? null : r.initial)); setIgnored(new Set()); setEditing(null); setError(''); };

  return <div className="viewer three-resolver">
    <div className="viewer-head"><button className="icon-button" aria-label="Back to the files" title="Back (Esc)" onClick={onClose}>←</button><span className="viewer-path mono">{path}</span></div>
    <div className="viewer-bar resolver-bar">
      <span className="resolver-count">{remaining} of {conflicts.length} conflicts left</span>
      <button aria-label="Previous conflict (Alt+Up)" title="Previous conflict (Alt+↑)" onClick={() => go(-1)} disabled={!conflicts.length}>↑</button>
      <button aria-label="Next conflict (Alt+Down)" title="Next conflict (Alt+↓)" onClick={() => go(1)} disabled={!conflicts.length}>↓</button>
      <button aria-pressed={base} onClick={() => setBase(!base)}>Base {base ? '−' : '+'}</button>
      <span className="resolver-spacer" />
      <button onClick={revert} disabled={busy}>Revert</button>
      <button className="button secondary small" onClick={() => void apply()} disabled={busy || remaining > 0 || !data} title={remaining ? 'Choose a result for every conflict' : undefined}>{busy ? 'Applying…' : 'Apply'}</button>
    </div>
    {error && <p className="files-note error" role="alert">{error}</p>}
    {!data && !error && <p className="files-note">Loading…</p>}
    {data && <>
      <div className="resolver-heads"><span>{data.labels.yours}</span><span>Result</span><span>{data.labels.incoming}</span></div>
      <div className="resolver-scroll" ref={scroll}>
        {regions.map((r, i) => <div className={`resolver-row${r.changed ? ' changed' : ''}${r.conflict ? ' conflict' : ''}${active === i && r.conflict ? ' active' : ''}`} data-region={i} key={i}>
          <div className={`resolver-cell${r.changed && r.yours !== r.base ? ' changed' : ''}`}><Code text={r.yours} path={path} before={r.base} />{r.conflict && <button className="resolver-arrow" title={`Take ${data.labels.yours}`} aria-label={`Take ${data.labels.yours} for conflict ${conflicts.indexOf(i) + 1}`} onClick={() => choose(i, r.yours)}>»</button>}</div>
          <div className={`resolver-cell result${r.conflict && values[i] === null ? ' unresolved' : r.changed ? ' changed' : ''}`}>
            {r.conflict && <div className="resolver-region-title">Conflict {conflicts.indexOf(i) + 1} of {conflicts.length}</div>}
            {editing === i ? <div className="resolver-edit"><textarea className="mono" aria-label={`Result block ${i + 1}`} value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.max(3, draft.split('\n').length + 1)} /><button onClick={() => choose(i, draft)}>Use edited text</button><button onClick={() => setEditing(null)}>Cancel</button></div> : <><Code text={values[i] ?? 'Choose a side or edit this block'} path={path} before={r.base} />{r.changed && <div className="resolver-actions">{r.conflict && <><button onClick={() => choose(i, r.yours + r.incoming)}>Both, yours first</button><button onClick={() => choose(i, r.incoming + r.yours)}>Both, incoming first</button></>}{!r.conflict && <button onClick={() => toggleIgnore(i)}>{ignored.has(i) ? 'Restore' : 'Ignore'}</button>}<button onClick={() => { setEditing(i); setDraft(values[i] ?? r.yours); }}>Edit</button></div>}</>}
            {base && r.changed && <div className="resolver-base"><span>Base</span><Code text={r.base} path={path} /></div>}
          </div>
          <div className={`resolver-cell${r.changed && r.incoming !== r.base ? ' changed' : ''}`}>{r.conflict && <button className="resolver-arrow left" title={`Take ${data.labels.incoming}`} aria-label={`Take ${data.labels.incoming} for conflict ${conflicts.indexOf(i) + 1}`} onClick={() => choose(i, r.incoming)}>«</button>}<Code text={r.incoming} path={path} before={r.base} /></div>
        </div>)}
      </div>
    </>}
  </div>;
}
