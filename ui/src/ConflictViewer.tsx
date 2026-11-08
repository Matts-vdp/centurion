import { useEffect, useRef, useState } from 'react';
import { gitApi, gitFailure, type Conflict, type GitStatus } from './fileStore';

type Props = { agentId: string; path: string; version: number; onClose: () => void; onResolver: () => void; resolverAvailable: boolean; onWritten: (status: GitStatus | null) => void; onError: (message: string) => void };

/** Inline conflict result: untouched spans come from Git's working merge, choices from index stages. */
export function ConflictViewer({ agentId, path, version, onClose, onResolver, resolverAvailable, onWritten, onError }: Props) {
  const [data, setData] = useState<Conflict | null>(null);
  const [choices, setChoices] = useState<(string | null)[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [bases, setBases] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const loadedHash = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError('');
    void gitApi.conflict(agentId, path).then((d) => { if (!cancelled) { if (loadedHash.current !== d.hash) { setChoices(d.blocks.map(() => null)); setEditing(null); loadedHash.current = d.hash; } setData(d); } })
      .catch((e) => !cancelled && setError(gitFailure(e).error));
    return () => { cancelled = true; };
  }, [agentId, path, version]);

  const take = async (side: 'yours' | 'incoming' | 'delete') => {
    if (!data) return;
    setBusy(true); setError('');
    try {
      const r = await gitApi.resolve(agentId, { path: data.path, take: side, hash: data.hash });
      onWritten(r.status);
      if (side === 'delete' || data.deleted === side) onClose();
    } catch (e) { const message = gitFailure(e).error; setError(message); onError(message); }
    finally { setBusy(false); }
  };
  const mark = async () => {
    if (!data?.merged || choices.some((c) => c === null)) return;
    let content = data.merged;
    const eol = data.merged.includes('\r\n') ? '\r\n' : '\n';
    for (let i = data.blocks.length - 1; i >= 0; i--) content = content.slice(0, data.blocks[i].start) + choices[i]!.replace(/\r?\n/g, eol) + content.slice(data.blocks[i].end);
    setBusy(true); setError('');
    try {
      const r = await gitApi.resolve(agentId, { path: data.path, content, hash: data.hash });
      onWritten(r.status);
    } catch (e) { const message = gitFailure(e).error; setError(message); onError(message); }
    finally { setBusy(false); }
  };
  const choose = (index: number, value: string) => { setChoices((old) => old.map((c, i) => i === index ? value : c)); setEditing(null); };
  const remaining = choices.filter((c) => c === null).length;
  const deleted = data?.deleted;
  const keep = deleted === 'yours' ? 'incoming' : 'yours';

  return <div className="viewer conflict-viewer">
    <div className="viewer-head"><button className="icon-button" aria-label="Back to the files" title="Back (Esc)" onClick={onClose}>←</button><span className="viewer-path mono">{path}</span></div>
    <div className="viewer-bar conflict-bar"><span>{data ? data.binary ? 'Binary conflict' : deleted ? 'File deleted on one side' : `${remaining} of ${data.blocks.length} left` : 'Conflict'}</span>
      {data && !data.binary && !deleted && resolverAvailable && <button className="button secondary small" onClick={onResolver}>Open in resolver</button>}
      {data && !data.binary && !deleted && <button className="button secondary small" disabled={busy || remaining > 0 || !data.blocks.length} title={remaining ? 'Choose a result for every block' : undefined} onClick={() => void mark()}>Mark resolved</button>}
    </div>
    <div className="viewer-body conflict-body">
      {error && <p className="files-note error" role="alert">{error}</p>}
      {!data && !error && <p className="files-note">Loading…</p>}
      {data && (data.binary || deleted) && <div className="conflict-whole">
        <p>{data.binary ? 'Choose which complete binary file to keep.' : `${deleted === 'yours' ? data.labels.yours : data.labels.incoming} deleted this file.`}</p>
        {deleted ? <><button className="button secondary small" disabled={busy} onClick={() => void take(keep)}>Keep the file</button><button className="button secondary small" disabled={busy} onClick={() => void take('delete')}>Delete it</button></> :
          <><button className="button secondary small" disabled={busy} onClick={() => void take('yours')}>Take yours · {data.labels.yours}</button><button className="button secondary small" disabled={busy} onClick={() => void take('incoming')}>Take incoming · {data.labels.incoming}</button></>}
      </div>}
      {data && !data.binary && !deleted && data.merged !== null && data.blocks.map((block, i) => {
        const previous = i ? data.blocks[i - 1].end : 0;
        const prefix = data.merged!.slice(previous, block.start);
        const selected = choices[i];
        return <div key={i}>
          {prefix && <pre className="conflict-context">{prefix}</pre>}
          <section className="conflict-block" aria-label={`Conflict ${i + 1} of ${data.blocks.length}`}>
            <div className="conflict-block-head"><strong>Conflict {i + 1} of {data.blocks.length}</strong><button onClick={() => setBases((old) => { const next = new Set(old); if (next.has(i)) next.delete(i); else next.add(i); return next; })} aria-expanded={bases.has(i)}>Base {bases.has(i) ? '−' : '+'}</button></div>
            {bases.has(i) && <div className="conflict-side"><span>{data.labels.base}</span><pre>{block.base}</pre></div>}
            {selected === null && editing !== i ? <>
              <div className="conflict-side"><span>{data.labels.yours}</span><pre>{block.yours}</pre></div>
              <div className="conflict-side"><span>{data.labels.incoming}</span><pre>{block.incoming}</pre></div>
              <div className="conflict-actions"><button onClick={() => choose(i, block.yours)}>Take yours</button><button onClick={() => choose(i, block.incoming)}>Take incoming</button><button onClick={() => choose(i, block.yours + block.incoming)}>Both, yours first</button><button onClick={() => choose(i, block.incoming + block.yours)}>Both, incoming first</button><button onClick={() => { setEditing(i); setDraft(block.yours); }}>Edit</button></div>
            </> : editing === i ? <div className="conflict-edit"><textarea className="mono" aria-label={`Result for conflict ${i + 1}`} value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.max(4, draft.split('\n').length + 1)} /><div className="conflict-actions"><button onClick={() => choose(i, draft)}>Use edited text</button><button onClick={() => setEditing(null)}>Cancel</button></div></div> :
              <div className="conflict-side resolved"><pre>{selected}</pre><button onClick={() => setChoices((old) => old.map((c, n) => n === i ? null : c))}>Change</button></div>}
          </section>
        </div>;
      })}
      {data?.merged !== null && data?.blocks.length ? <pre className="conflict-context">{data.merged.slice(data.blocks[data.blocks.length - 1].end)}</pre> : null}
    </div>
  </div>;
}
