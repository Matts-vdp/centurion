import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { commitDrafts, diffLayout, gitApi, gitFailure, repoTop, type CommitDetails, type FileDiff, type GitStatus, type LogCommit } from './fileStore';
import { parseDiff } from './diffModel';
import { DiffView } from './DiffView';
import { BackIcon, CopyIcon, ForkIcon, MoreIcon } from './icons';
import type { ResultLine } from './Changes';

type Props = { agentId: string; rootPath: string; status: GitStatus | null; version: number; range: string | null; selected: string | null; onSelect: (hash: string | null) => void; onClearRange: () => void; onWritten: (status: GitStatus | null) => void; onResult: (result: ResultLine) => void };

/** Active lane hashes and their outgoing edges are calculated from parent hashes, across page boundaries. */
function graph(commits: LogCommit[], head: string | null) {
  const lanes: string[] = [];
  const firstParent = new Set<string>();
  if (head) firstParent.add(head);
  return commits.map((commit) => {
    let column = lanes.indexOf(commit.hash);
    if (column < 0) { column = lanes.length; lanes.push(commit.hash); }
    const before = [...lanes];
    const first = commit.parents[0];
    if (firstParent.has(commit.hash) && first) firstParent.add(first);
    if (first) {
      if (lanes.includes(first)) lanes.splice(column, 1);
      else lanes[column] = first;
    } else lanes.splice(column, 1);
    for (let i = 1; i < commit.parents.length; i++) if (!lanes.includes(commit.parents[i])) lanes.splice(column + i, 0, commit.parents[i]);
    // Another branch can meet a parent already in a lane: join its line at that lane.
    const edges = commit.parents.map((parent, index) => ({ to: lanes.indexOf(parent), main: index === 0 && firstParent.has(commit.hash) }));
    return { column, before: before.length, after: lanes.length, edges, main: firstParent.has(commit.hash) };
  });
}

function Graph({ commits, head }: { commits: LogCommit[]; head: string | null }) {
  const rows = graph(commits, head);
  const width = Math.max(24, ...rows.map((row) => Math.max(row.before, row.after, row.column + 1) * 12 + 12));
  return rows.map((row, i) => <svg key={commits[i].hash} className="log-graph" width={width} height="26" viewBox={`0 0 ${width} 26`} aria-hidden="true">
    {Array.from({ length: row.before }, (_, lane) => lane !== row.column && <path key={`in-${lane}`} d={`M ${lane * 12 + 8} 0 V 13`} />)}
    <path className={row.main ? 'main' : ''} d={`M ${row.column * 12 + 8} 0 V 13`} />
    {row.edges.map((edge, k) => edge.to >= 0 && <path key={`out-${k}`} className={edge.main ? 'main' : ''} d={`M ${row.column * 12 + 8} 13 C ${row.column * 12 + 8} 20, ${edge.to * 12 + 8} 19, ${edge.to * 12 + 8} 26`} />)}
    {Array.from({ length: row.after }, (_, lane) => !row.edges.some((edge) => edge.to === lane) && <path key={`through-${lane}`} d={`M ${lane * 12 + 8} 13 V 26`} />)}
    {commits[i].hash === head ? <circle className="head" cx={row.column * 12 + 8} cy="13" r="4" /> : <circle className={row.main ? 'main-dot' : ''} cx={row.column * 12 + 8} cy="13" r="3.5" />}
  </svg>);
}

function relative(date: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 1000));
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)}d`;
  if (seconds < 86400 * 365) return `${Math.floor(seconds / (86400 * 30))}mo`;
  return `${Math.floor(seconds / (86400 * 365))}y`;
}

export function Log({ agentId, rootPath, status, version, range, selected, onSelect, onClearRange, onWritten, onResult }: Props) {
  const [scope, setScope] = useState<'branch' | 'all'>('branch');
  const [filter, setFilter] = useState('');
  const [commits, setCommits] = useState<LogCommit[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [menu, setMenu] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const fetched = useRef<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const graphs = useMemo(() => Graph({ commits, head: status?.head ?? null }), [commits, status?.head]);
  const load = async (skip: number) => {
    const id = ++request.current;
    setLoading(true); setError('');
    try {
      const result = await gitApi.log(agentId, { scope, filter, skip, ...(range ? { range } : {}) });
      if (id !== request.current) return;
      setCommits((old) => skip ? [...old, ...result.commits] : result.commits);
      setMore(result.more);
    } catch (err) { if (id === request.current) setError(gitFailure(err).error); }
    finally { if (id === request.current) setLoading(false); }
  };
  useEffect(() => { const timer = window.setTimeout(() => void load(0), filter ? 250 : 0); return () => { window.clearTimeout(timer); request.current++; }; }, [agentId, scope, filter, range, version]);
  useEffect(() => {
    if (!status || (status.fetchedAt !== null && Date.now() - status.fetchedAt < 5 * 60_000)) return;
    const key = `${agentId}:${status.branch}:${status.fetchedAt}`;
    if (fetched.current === key) return;
    fetched.current = key;
    void gitApi.remote(agentId, 'fetch').then((r) => onWritten(r.status)).catch((err) => { const f = gitFailure(err); onResult({ error: true, text: f.error, details: f.details, commands: f.commands }); });
  }, [agentId, status?.branch, status?.fetchedAt]);
  const rowKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = index + (event.key === 'ArrowDown' ? 1 : -1);
      list.current?.querySelectorAll<HTMLButtonElement>('.log-row-main').item(next)?.focus();
    }
  };
  const runBranch = async (hash: string) => {
    if (!branch?.trim()) return;
    setBusy(true);
    try {
      const r = await gitApi.branch(agentId, { name: branch.trim(), from: hash, switch: false });
      onWritten(r.status); onResult({ error: false, text: `Created ${branch.trim()} from ${hash.slice(0, 7)}`, details: '', commands: r.commands });
      setBranch(null); setMenu(null);
    } catch (err) { const f = gitFailure(err); onResult({ error: true, text: f.error, details: f.details, commands: f.commands }); }
    finally { setBusy(false); }
  };
  const undo = async (hash: string) => {
    setBusy(true);
    try {
      const r = await gitApi.undoCommit(agentId, hash);
      const top = repoTop(rootPath, status?.prefix ?? '');
      const previous = commitDrafts.read(top);
      commitDrafts.write(top, previous.trim() ? `${r.message}\n\n${previous}` : r.message);
      onWritten(r.status); onResult({ error: false, text: `Undid ${hash.slice(0, 7)}`, details: '', commands: r.commands });
      onSelect(null); setMenu(null);
    } catch (err) { const f = gitFailure(err); onResult({ error: true, text: f.error, details: f.details, commands: f.commands }); }
    finally { setBusy(false); }
  };
  return <div className="log-panel">
    <div className="log-controls"><span className="mono">{range ?? status?.branch ?? 'HEAD'}</span>{!range && <div className="segmented"><button className={scope === 'branch' ? 'on' : ''} aria-pressed={scope === 'branch'} onClick={() => setScope('branch')}>This branch</button><button className={scope === 'all' ? 'on' : ''} aria-pressed={scope === 'all'} onClick={() => setScope('all')}>All branches</button></div>}</div>
    {range && <button className="log-clear" onClick={onClearRange}>Clear comparison</button>}
    <div className="files-filter"><input type="search" aria-label="Filter commits by subject, author or hash" placeholder="Filter subject, author or hash…" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
    <div className="log-list" ref={list}>
      {error && <p className="files-note">{error}</p>}
      {!loading && !error && commits.length === 0 && <p className="files-note">No commits found.</p>}
      {commits.map((commit, i) => <div className={`log-row${selected === commit.hash ? ' selected' : ''}`} key={commit.hash}>
        <button className="log-row-main" title={`${commit.hash} · ${commit.author} · ${new Date(commit.date).toLocaleString()}`} onClick={() => onSelect(commit.hash)} onKeyDown={(e) => rowKey(e, i)}>
          {graphs[i]}<span className="log-message">{commit.refs.map((ref, j) => <span className="log-ref mono" key={`${ref.kind}:${ref.name}:${j}`}>{ref.kind === 'tag' ? '◇' : ref.kind === 'remote' ? '☁' : <ForkIcon size={11} />}{ref.name}</span>)}<span className="log-subject">{commit.subject}</span></span>
          <span className="log-author mono">{commit.author.split(' ')[0]}</span><span className="log-time mono">{relative(commit.date)}</span><span className="log-sync mono">{commit.incoming ? '↓' : !commit.pushed ? '↑' : ''}</span>
        </button>
        <button className="log-more icon-button small" aria-label={`Actions for ${commit.subject}`} aria-expanded={menu === commit.hash} onClick={() => { setMenu(menu === commit.hash ? null : commit.hash); setBranch(null); }}><MoreIcon size={14} /></button>
        {menu === commit.hash && <div className="menu git-menu log-menu"><button onClick={() => { void navigator.clipboard.writeText(commit.hash); setMenu(null); }}>Copy hash</button><button onClick={() => setBranch('')}>New branch from here</button>{commit.hash === status?.head && !status.headPushed && commit.parents.length === 1 && !status.operation && <button disabled={busy} onClick={() => void undo(commit.hash)}>Undo commit</button>}{branch !== null && <div className="log-branch-create"><input autoFocus aria-label="New branch name" placeholder="Branch name" value={branch} onChange={(e) => setBranch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void runBranch(commit.hash)} /><button disabled={busy || !branch.trim()} onClick={() => void runBranch(commit.hash)}>Create</button></div>}</div>}
      </div>)}
      {more && <button className="log-load" disabled={loading} onClick={() => void load(commits.length)}>Load more</button>}
      {loading && <p className="files-note">Loading commits…</p>}
    </div>
  </div>;
}

export function LogViewer({ agentId, rootPath, status, hash, onClose, onSelect, onWritten, onResult }: { agentId: string; rootPath: string; status: GitStatus | null; hash: string; onClose: () => void; onSelect: (hash: string) => void; onWritten: (status: GitStatus | null) => void; onResult: (result: ResultLine) => void }) {
  const [details, setDetails] = useState<CommitDetails | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState('');
  const [layout, setLayout] = useState(diffLayout.get);
  const [branch, setBranch] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { let cancelled = false; setDetails(null); setFile(null); setError(''); void gitApi.details(agentId, hash).then((r) => !cancelled && setDetails(r)).catch((e) => !cancelled && setError(gitFailure(e).error)); return () => { cancelled = true; }; }, [agentId, hash]);
  useEffect(() => { if (!file) return; let cancelled = false; setDiff(null); setError(''); void gitApi.commitDiff(agentId, hash, file).then((r) => !cancelled && setDiff(r)).catch((e) => !cancelled && setError(gitFailure(e).error)); return () => { cancelled = true; }; }, [agentId, hash, file]);
  const hunks = useMemo(() => diff && !diff.binary ? parseDiff(diff.diff) : [], [diff]);
  const create = async () => {
    if (!branch?.trim()) return;
    setBusy(true);
    try { const r = await gitApi.branch(agentId, { name: branch.trim(), from: hash, switch: false }); onWritten(r.status); onResult({ error: false, text: `Created ${branch.trim()} from ${hash.slice(0, 7)}`, details: '', commands: r.commands }); setBranch(null); }
    catch (err) { const f = gitFailure(err); onResult({ error: true, text: f.error, details: f.details, commands: f.commands }); }
    finally { setBusy(false); }
  };
  const undo = async () => {
    setBusy(true);
    try { const r = await gitApi.undoCommit(agentId, hash); const top = repoTop(rootPath, status?.prefix ?? ''); const previous = commitDrafts.read(top); commitDrafts.write(top, previous.trim() ? `${r.message}\n\n${previous}` : r.message); onWritten(r.status); onResult({ error: false, text: `Undid ${hash.slice(0, 7)}`, details: '', commands: r.commands }); onClose(); }
    catch (err) { const f = gitFailure(err); onResult({ error: true, text: f.error, details: f.details, commands: f.commands }); }
    finally { setBusy(false); }
  };
  return <div className="viewer log-viewer"><div className="viewer-head"><button className="icon-button" aria-label={file ? 'Back to commit' : 'Back to log'} onClick={() => file ? setFile(null) : onClose()}><BackIcon size={15} /></button><span className="mono">{file ?? hash.slice(0, 7)}</span></div>
    {error && <p className="files-note">{error}</p>}
    {!details && !error && <p className="files-note">Loading commit…</p>}
    {details && !file && <div className="log-details"><h2>{details.subject}</h2>{details.body.trim() && <pre>{details.body.trim()}</pre>}<div className="log-meta mono"><button title="Copy full hash" onClick={() => void navigator.clipboard.writeText(hash)}><CopyIcon size={12} /> {hash.slice(0, 12)}</button><span>{details.author.name} &lt;{details.author.email}&gt;</span><time dateTime={details.author.date}>{new Date(details.author.date).toLocaleString()}</time>{details.parents.length > 0 && <span>Parents: {details.parents.map((p) => <button key={p} onClick={() => onSelect(p)}>{p.slice(0, 7)}</button>)}</span>}</div><div className="log-detail-actions"><button onClick={() => void navigator.clipboard.writeText(hash)}>Copy hash</button><button onClick={() => setBranch('')}>New branch from here</button>{hash === status?.head && !status.headPushed && details.parents.length === 1 && !status.operation && <button disabled={busy} onClick={() => void undo()}>Undo commit</button>}{branch !== null && <div className="log-branch-create"><input aria-label="New branch name" placeholder="Branch name" value={branch} onChange={(e) => setBranch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} /><button disabled={busy || !branch.trim()} onClick={() => void create()}>Create</button></div>}</div><div className="log-files"><h3>Changed files · {details.files.length}{details.parents.length > 1 ? ' · against first parent' : ''}</h3>{details.files.map((entry) => <button key={entry.path} className="file-row flat" disabled={!entry.inside} title={entry.inside ? entry.path : 'Outside the agent’s folder'} onClick={() => setFile(entry.path)}><span className="git-letter mono lead">{entry.status}</span><span className="file-name">{entry.path}</span>{!entry.inside && <span className="file-hint">outside folder</span>}<span className="git-lines mono">{entry.added !== null && `+${entry.added} −${entry.removed ?? 0}`}</span></button>)}</div></div>}
    {file && <div className="log-file-diff"><div className="log-diff-head"><span>{details?.parents.length && details.parents.length > 1 ? 'against first parent' : 'Commit diff'}</span><div className="segmented"><button className={layout === 'unified' ? 'on' : ''} onClick={() => { setLayout('unified'); diffLayout.set('unified'); }}>Unified</button><button className={layout === 'split' ? 'on' : ''} onClick={() => { setLayout('split'); diffLayout.set('split'); }}>Split</button></div></div>{diff ? <DiffView key={`${hash}:${file}`} diff={diff} hunks={hunks} layout={layout} actions={null} untracked={false} name={file} emptyText="No text changes." loadText={async () => null} onApply={async () => false} onFile={async () => false} /> : !error && <p className="files-note">Loading diff…</p>}</div>}
  </div>;
}
