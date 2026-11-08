import { useEffect, useRef, useState } from 'react';
import { gitApi, gitFailure, type GitBranches, type GitStatus } from './fileStore';
import type { ResultLine } from './Changes';

type Props = {
  at: { left: number; top: number }; agentId: string; status: GitStatus; onWritten: (status: GitStatus | null) => void;
  onResult: (result: ResultLine) => void; onClose: () => void;
};

/** Step 6 branch picker. The comparison uses the existing log range route until the Log segment lands. */
export function BranchPopover({ at, agentId, status, onWritten, onResult, onClose }: Props) {
  const [data, setData] = useState<GitBranches | null>(null);
  const [filter, setFilter] = useState('');
  const [from, setFrom] = useState(status.branch ?? status.head ?? 'HEAD');
  const [starts, setStarts] = useState(false);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [row, setRow] = useState<string | null>(null);
  const [rebaseState, setRebaseState] = useState<{ name: string; blocked: boolean | null; error?: string } | null>(null);
  const [confirm, setConfirm] = useState<{ name: string; force: boolean } | null>(null);
  const [busy, setBusy] = useState('');
  const [comparison, setComparison] = useState<{ branch: string; incoming: { hash: string; subject: string }[]; outgoing: { hash: string; subject: string }[] } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    void gitApi.branches(agentId).then(setData).catch((err) => {
      const f = gitFailure(err); onResult({ error: true, text: f.error, details: f.details, commands: f.commands });
    });
  }, [agentId]);

  const run = async (label: string, fn: () => Promise<{ status: GitStatus | null; commands: ResultLine['commands']; stashConflict?: boolean; conflicted?: boolean }>) => {
    setBusy(label);
    try {
      const result = await fn();
      onWritten(result.status);
      onResult({ error: false, text: result.stashConflict ? `Switched branch, but restoring local changes conflicted. The stash was kept; resolve the conflicts and restore it from Git later` : result.conflicted ? `${label} has conflicts. Resolve them, then Continue or Abort` : label, details: '', commands: result.commands });
      onClose();
    } catch (err) {
      const f = gitFailure(err);
      onResult({ error: true, text: f.error, details: f.details, commands: f.commands });
    } finally { setBusy(''); }
  };

  const create = () => {
    const name = filter.trim();
    if (name) void run(`Created ${name}`, () => gitApi.branch(agentId, { name, from, switch: true }));
  };
  const deleteBranch = async (name: string, force: boolean) => {
    setBusy(`Deleting ${name}…`);
    try {
      const result = await gitApi.branch(agentId, { name, delete: true, force });
      onWritten(result.status);
      onResult({ error: false, text: `Deleted ${name}`, details: '', commands: result.commands });
      setConfirm(null); setRow(null);
      setData(await gitApi.branches(agentId));
    } catch (err) {
      const f = gitFailure(err);
      if (!force && /not merged/i.test(f.error)) setConfirm({ name, force: true });
      else onResult({ error: true, text: f.error, details: f.details, commands: f.commands });
    } finally { setBusy(''); }
  };
  const compare = async (branch: string) => {
    if (!status.branch) return;
    setBusy('Comparing…');
    try {
      const [incoming, outgoing] = await Promise.all([
        gitApi.compare(agentId, `${status.branch}..${branch}`),
        gitApi.compare(agentId, `${branch}..${status.branch}`),
      ]);
      setComparison({ branch, incoming: incoming.commits, outgoing: outgoing.commits });
    } catch (err) {
      const f = gitFailure(err); onResult({ error: true, text: f.error, details: f.details, commands: f.commands });
    } finally { setBusy(''); }
  };
  const openRow = (name: string) => {
    if (row === name) { setRow(null); return; }
    setRow(name); setConfirm(null);
    if (name === status.branch || !status.branch) return;
    setRebaseState({ name, blocked: null });
    void gitApi.rebaseSafety(agentId, name).then(({ blocked }) => setRebaseState((old) => old?.name === name ? { name, blocked } : old)).catch((err) => setRebaseState((old) => old?.name === name ? { name, blocked: true, error: gitFailure(err).error } : old));
  };

  const query = filter.trim().toLowerCase();
  const exact = data?.local.some((b) => b.name.toLowerCase() === query) || data?.remote.some((b) => b.name.toLowerCase() === query);
  const canCreate = !!filter.trim() && !exact;
  const current = status.branch ?? (status.head ? status.head.slice(0, 7) : 'HEAD');

  const branchRow = (name: string, local: boolean, counts?: { ahead: number; behind: number; current: boolean }) => (
    <div className="branch-pop-row" key={name}>
      <button className="branch-pop-name mono" onClick={() => name !== status.branch && void run(`Switched to ${name}`, () => gitApi.switch(agentId, name))} disabled={!!busy || name === status.branch} title={name === status.branch ? 'Current branch' : `Switch to ${name}`}>
        <span>{counts?.current ? '✓ ' : ''}{name}</span>
        {counts && <span className="branch-pop-count">{counts.behind ? `↓${counts.behind} ` : ''}{counts.ahead ? `↑${counts.ahead}` : ''}</span>}
      </button>
      <button className="icon-button small" aria-label={`Actions for ${name}`} aria-expanded={row === name} onClick={() => openRow(name)}>⋯</button>
      {row === name && <div className="branch-pop-actions">
        {name !== status.branch && <button onClick={() => void run(`Switched to ${name}`, () => gitApi.switch(agentId, name))}>Switch</button>}
        {status.branch && name !== status.branch && <>
          <button onClick={() => void run(`Merged ${name} into ${status.branch}`, () => gitApi.merge(agentId, name))}>Merge into {status.branch}</button>
          <button disabled={rebaseState?.name !== name || rebaseState.blocked !== false} title={rebaseState?.error ?? (rebaseState?.blocked ? 'Already pushed: rebasing would need a force push' : undefined)} onClick={() => void run(`Rebased ${status.branch} onto ${name}`, () => gitApi.rebase(agentId, name))}>Rebase {status.branch} onto this{rebaseState?.name === name && rebaseState.blocked === null ? ' · checking…' : rebaseState?.error ? ' · unavailable' : rebaseState?.blocked ? ' · already pushed' : ''}</button>
          <button onClick={() => void compare(name)}>Compare with current</button>
        </>}
        {local && name !== status.branch && <button onClick={() => setConfirm({ name, force: false })}>Delete…</button>}
        {confirm?.name === name && <div className="branch-pop-confirm">
          <span>{confirm.force ? `Delete ${name} even though it is not merged? Its commits may be lost.` : `Delete local branch ${name}?`}</span>
          <button onClick={() => setConfirm(null)}>Cancel</button>
          <button className="danger" onClick={() => void deleteBranch(name, confirm.force)}>{confirm.force ? 'Delete unmerged branch' : 'Delete branch'}</button>
        </div>}
      </div>}
    </div>
  );

  return <div className="branch-popover" role="dialog" aria-label="Branches" style={{ left: at.left, top: at.top }}>
    <input ref={input} type="search" placeholder="Switch to or create a branch…" aria-label="Switch to or create a branch" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && canCreate) create(); if (e.key === 'Escape') onClose(); }} />
    {busy && <div className="branch-pop-note">{busy}</div>}
    {comparison ? <div className="branch-pop-compare">
      <button onClick={() => setComparison(null)}>← Branches</button>
      <strong>{current} ↔ {comparison.branch}</strong>
      <span>On {comparison.branch} only · {comparison.incoming.length}</span>
      {comparison.incoming.slice(0, 20).map((c) => <div className="mono" key={c.hash}>{c.hash.slice(0, 7)} {c.subject}</div>)}
      <span>On {current} only · {comparison.outgoing.length}</span>
      {comparison.outgoing.slice(0, 20).map((c) => <div className="mono" key={c.hash}>{c.hash.slice(0, 7)} {c.subject}</div>)}
    </div> : <>
      {data?.default && status.branch && status.branch !== data.default && <button className="branch-pop-primary" disabled={!!busy} onClick={() => void run(`Updated from ${data.default}`, () => gitApi.updateDefault(agentId))}>Update from {data.default}</button>}
      {canCreate && <div className="branch-pop-create">
        <button disabled={!!busy} onClick={create}>Create <code>{filter.trim()}</code> from <code>{from}</code></button>
        <button aria-label="Choose start point" onClick={() => setStarts(!starts)}>⋯</button>
        {starts && <div className="branch-pop-starts">{[...new Set([current, ...(data?.local.map((b) => b.name) ?? []), ...(data?.remote.map((b) => b.name) ?? [])])].map((name) => <button key={name} onClick={() => { setFrom(name); setStarts(false); }}>{name}</button>)}</div>}
      </div>}
      <div className="branch-pop-heading">Local branches</div>
      {data?.local.filter((b) => b.name.toLowerCase().includes(query)).map((b) => branchRow(b.name, true, b))}
      <button className="branch-pop-heading fold" aria-expanded={remoteOpen} onClick={() => setRemoteOpen(!remoteOpen)}>{remoteOpen ? '⌄' : '›'} Remote branches · {data?.remote.length ?? 0}</button>
      {remoteOpen && data?.remote.filter((b) => b.name.toLowerCase().includes(query)).map((b) => branchRow(b.name, false))}
      {!data && <div className="branch-pop-note">Loading branches…</div>}
    </>}
  </div>;
}
