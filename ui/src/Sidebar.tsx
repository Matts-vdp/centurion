import { useEffect, useRef, useState, type FormEvent } from 'react';
import { commands, type AgentRecord } from './api';
import { ArchiveIcon, Chevron, PlusIcon } from './icons';
import { isUnread, lastSeen, store, treeState } from './store';
import { StatusDot } from './StatusDot';

type Props = {
  agents: Map<string, AgentRecord>;
  selected: string | null;
  onSelect: (id: string) => void;
};

const byCreated = (a: AgentRecord, b: AgentRecord) => a.createdAt.localeCompare(b.createdAt);

export function Sidebar({ agents, selected, onSelect }: Props) {
  const seen = lastSeen.use();
  const tree = treeState.use();
  const [creating, setCreating] = useState(false);

  // Opening an agent (from a link, the breadcrumb or archiving it) reveals it in the tree once.
  const open = selected ? agents.get(selected) : undefined;
  const openParent = open?.parentId ?? null;
  const openArchived = open?.archived === true;
  useEffect(() => {
    if (!openParent) return;
    treeState.set(openParent, false);
    if (openArchived) treeState.set(`archived:${openParent}`, true);
  }, [selected, openParent, openArchived]);

  const list = [...agents.values()].sort(byCreated);
  const orchestrators = list.filter((a) => !a.parentId);
  const childrenOf = (id: string) => list.filter((a) => a.parentId === id);

  return (
    <div className="sidebar-inner">
      <div className="sidebar-title">
        <span>Agents</span>
        <button className="icon-button" title="New orchestrator" onClick={() => setCreating(true)}>
          <PlusIcon />
        </button>
      </div>
      {creating && (
        <NewOrchestrator
          onDone={(rec) => {
            setCreating(false);
            if (rec) onSelect(rec.id);
          }}
        />
      )}
      <div className="tree" role="tree">
        {orchestrators.length === 0 && !creating && (
          <div className="tree-empty">
            No agents yet.
            <button className="link-button" onClick={() => setCreating(true)}>
              Start an orchestrator
            </button>
          </div>
        )}
        {orchestrators.map((o) => {
          const children = childrenOf(o.id);
          const active = children.filter((c) => !c.archived);
          const archived = children.filter((c) => c.archived);
          const collapsed = tree[o.id] === true;
          const archivedOpen = tree[`archived:${o.id}`] === true;
          return (
            <div key={o.id} role="group">
              <Row
                agent={o}
                depth={0}
                selected={selected === o.id}
                unread={isUnread(o, seen)}
                onSelect={onSelect}
                chevron={children.length > 0 ? { open: !collapsed, toggle: () => treeState.set(o.id, !collapsed) } : undefined}
                rollup={rollup(active, seen)}
              />
              {!collapsed &&
                active.map((c) => (
                  <Row key={c.id} agent={c} depth={1} selected={selected === c.id} unread={isUnread(c, seen)} onSelect={onSelect} />
                ))}
              {!collapsed && archived.length > 0 && (
                <>
                  <div
                    className="tree-row group-row"
                    style={{ paddingLeft: indent(1) }}
                    role="treeitem"
                    aria-expanded={archivedOpen}
                    onClick={() => treeState.set(`archived:${o.id}`, !archivedOpen)}
                  >
                    <Chevron open={archivedOpen} size={14} className="chevron" />
                    <ArchiveIcon size={14} className="muted-icon" />
                    <span className="row-name">Archived ({archived.length})</span>
                  </div>
                  {archivedOpen &&
                    archived.map((c) => (
                      <Row
                        key={c.id}
                        agent={c}
                        depth={2}
                        selected={selected === c.id}
                        unread={isUnread(c, seen)}
                        onSelect={onSelect}
                        dim
                      />
                    ))}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const indent = (depth: number) => 8 + depth * 16;

function rollup(children: AgentRecord[], seen: Record<string, string>): string {
  const count = (pred: (a: AgentRecord) => boolean) => children.filter(pred).length;
  const parts: string[] = [];
  const running = count((a) => a.status === 'running');
  const errors = count((a) => a.status === 'error');
  const interrupted = count((a) => a.status === 'interrupted');
  const unread = count((a) => isUnread(a, seen));
  if (running) parts.push(`${running} running`);
  if (errors) parts.push(`${errors} error`);
  if (interrupted) parts.push(`${interrupted} interrupted`);
  if (unread) parts.push(`${unread} new`);
  return parts.join(' · ');
}

type RowProps = {
  agent: AgentRecord;
  depth: number;
  selected: boolean;
  unread: boolean;
  onSelect: (id: string) => void;
  chevron?: { open: boolean; toggle: () => void };
  rollup?: string;
  dim?: boolean;
};

function Row({ agent, depth, selected, unread, onSelect, chevron, rollup, dim }: RowProps) {
  const queued = agent.queue.length;
  const title = [
    `${agent.name} (${agent.kind})`,
    `Status: ${agent.status}`,
    queued ? `${queued} queued` : '',
    agent.lastError ? `Last error: ${agent.lastError.slice(0, 200)}` : '',
    agent.cwd,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <div
      className={`tree-row${selected ? ' selected' : ''}${dim ? ' dim' : ''}${unread ? ' unread' : ''}`}
      style={{ paddingLeft: indent(depth) }}
      role="treeitem"
      aria-selected={selected}
      aria-expanded={chevron?.open}
      title={title}
      onClick={() => onSelect(agent.id)}
    >
      {chevron ? (
        <button
          className="chevron-button"
          aria-label={chevron.open ? 'Collapse' : 'Expand'}
          onClick={(e) => {
            e.stopPropagation();
            chevron.toggle();
          }}
        >
          <Chevron open={chevron.open} size={14} />
        </button>
      ) : (
        depth === 0 && <span className="chevron-spacer" />
      )}
      <StatusDot status={agent.status} />
      <span className="row-name">{agent.name}</span>
      {rollup && <span className="row-rollup">{rollup}</span>}
      {queued > 0 && (
        <span className="badge" title={`${queued} queued`}>
          {queued}
        </span>
      )}
      {unread && <span className="unread-dot" title="New activity since you last looked" />}
    </div>
  );
}

function NewOrchestrator({ onDone }: { onDone: (rec: AgentRecord | null) => void }) {
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [folder, setFolder] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    commands
      .info()
      .then((i) => setFolder(i.orchestratorFolder))
      .catch(() => {});
  }, []);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const rec = await commands.createOrchestrator(name.trim(), message.trim() || undefined);
      store.upsert(rec);
      onDone(rec);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <form
      className="new-orchestrator"
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onDone(null);
      }}
    >
      <input ref={nameRef} placeholder="Orchestrator name" value={name} onChange={(e) => setName(e.target.value)} />
      <textarea
        placeholder="First message (optional)"
        rows={3}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      {folder && (
        <div className="hint" title={folder}>
          Runs in {folder}
        </div>
      )}
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        <button type="button" className="button secondary" onClick={() => onDone(null)}>
          Cancel
        </button>
        <button type="submit" className="button primary" disabled={!name.trim() || busy}>
          Start
        </button>
      </div>
    </form>
  );
}
