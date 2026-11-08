import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { AlertsMenu } from './AlertsMenu';
import { commands, type AgentRecord } from './api';
import { sameFolder, useNow, useServerInfo } from './hooks';
import { ArchiveIcon, Chevron, PlusIcon, SearchIcon } from './icons';
import { DRAG_TYPE } from './layout';
import { AgentMark } from './Mark';
import { agentState, archiveBlocker, clock, folderName, money, needsYou, rollup, type AgentState } from './status';
import { lastSeen, newExpertFor, openNewExpert, recentChatFolders, recentFolders, store, treeState, useManager } from './store';
import { continueList, indentList } from './listInput';

type Props = {
  agents: Map<string, AgentRecord>;
  /** The focused pane's agent. */
  selected: string | null;
  /** Every agent on screen (one or two panes). */
  open: string[];
  onSelect: (id: string) => void;
  onOpenInSplit: (id: string) => void;
  onSearch: () => void;
};

type RowMenu = { id: string; x: number; y: number };

const byCreated = (a: AgentRecord, b: AgentRecord) => a.createdAt.localeCompare(b.createdAt);

export function Sidebar({ agents, selected, open: openIds, onSelect, onOpenInSplit, onSearch }: Props) {
  const { activity } = useManager();
  const seen = lastSeen.use();
  const tree = treeState.use();
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const [error, setError] = useState('');
  const expertFor = newExpertFor.use();
  const list = [...agents.values()].sort(byCreated);
  const anyRunning = list.some((a) => a.status === 'running');
  const now = useNow(true, anyRunning ? 1000 : 30_000);

  // Opening an agent (from a link, the breadcrumb or archiving it) reveals it in the tree once.
  const open = selected ? agents.get(selected) : undefined;
  const openParent = open?.parentId ?? null;
  const openArchived = open?.archived === true;
  const chatArchived = (open?.parentId ? agents.get(open.parentId)?.archived : open?.archived) === true;
  useEffect(() => {
    if (chatArchived) {
      treeState.set('archived:chats', true);
      if (openParent) treeState.set(`open:${openParent}`, true);
      return;
    }
    if (!openParent) return;
    treeState.set(openParent, false);
    if (openArchived) treeState.set(`archived:${openParent}`, true);
  }, [selected, openParent, openArchived, chatArchived]);

  const archive = async (a: AgentRecord) => {
    setError('');
    try {
      store.upsert(await commands.setArchived(a.id, !a.archived));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const states = new Map<string, AgentState>(list.map((a) => [a.id, agentState(a, agents, seen, activity.get(a.id), now)]));
  const state = (a: AgentRecord) => states.get(a.id)!;
  const chats = list.filter((a) => !a.parentId);
  const orchestrators = chats.filter((a) => !a.archived);
  const archivedChats = chats.filter((a) => a.archived).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  const archivedChatsOpen = tree['archived:chats'] === true;
  const childrenOf = (id: string) => list.filter((a) => a.parentId === id);
  const needs = list.filter((a) => needsYou(a, state(a))).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  const running = list.filter((a) => a.status === 'running').length;
  const spend = list.reduce((sum, a) => sum + a.costUsd, 0);

  const rowProps = (a: AgentRecord) => ({
    agent: a,
    state: state(a),
    selected: selected === a.id,
    onScreen: selected !== a.id && openIds.includes(a.id),
    onSelect,
    archiveBlocked: archiveBlocker(a, agents),
    onArchive: () => void archive(a),
    onMenu: (e: ReactMouseEvent) => {
      e.preventDefault();
      setMenu({ id: a.id, x: e.clientX, y: e.clientY });
    },
  });

  /** A chat with its experts. In the archived group every expert shows (they went with it), folded by default. */
  const chatGroup = (o: AgentRecord, inArchive: boolean) => {
    const children = childrenOf(o.id);
    const active = inArchive ? children : children.filter((c) => !c.archived);
    const archived = inArchive ? [] : children.filter((c) => c.archived);
    const collapsed = inArchive ? tree[`open:${o.id}`] !== true : tree[o.id] === true;
    const toggle = () => (inArchive ? treeState.set(`open:${o.id}`, collapsed) : treeState.set(o.id, !collapsed));
    const archivedOpen = tree[`archived:${o.id}`] === true;
    const roll = collapsed && !inArchive ? rollup(active, seen) : '';
    return (
      <div key={o.id} role="group" className="tree-group">
        <Row
          {...rowProps(o)}
          dim={inArchive}
          line={roll && o.status !== 'running' && o.status !== 'error' ? roll : undefined}
          expander={children.length > 0 ? { open: !collapsed, toggle } : undefined}
          extra={collapsed && children.length > 0 ? `${children.length} expert${children.length === 1 ? '' : 's'}` : undefined}
        />
        {!inArchive && expertFor === o.id && (
          <NewExpert
            chat={o}
            agents={agents}
            onDone={(rec) => {
              newExpertFor.set(null);
              if (rec) onSelect(rec.id);
            }}
          />
        )}
        {!collapsed && children.length > 0 && (
          <div className="tree-children">
            {active.map((c) => (
              <Row key={c.id} {...rowProps(c)} parentId={o.id} dim={inArchive} />
            ))}
            {archived.length > 0 && (
              <GroupToggle
                label={`Archived · ${archived.length}`}
                open={archivedOpen}
                parentId={o.id}
                onToggle={() => treeState.set(`archived:${o.id}`, !archivedOpen)}
              />
            )}
            {archivedOpen && archived.map((c) => <Row key={c.id} {...rowProps(c)} parentId={o.id} dim />)}
          </div>
        )}
      </div>
    );
  };

  const menuAgent = menu ? agents.get(menu.id) : undefined;
  const menuBlocker = menuAgent ? archiveBlocker(menuAgent, agents) : null;

  return (
    <div className="sidebar-inner">
      <div className="sidebar-head">
        <LogoIcon />
        <span className="app-name">Centurion</span>
        <AlertsMenu />
        <button className="icon-button" title="New chat" aria-label="New chat" onClick={() => setCreating(true)}>
          <PlusIcon size={16} />
        </button>
      </div>
      <button className="search-field" onClick={onSearch}>
        <SearchIcon size={15} />
        <span>Search or jump to…</span>
        <kbd>Ctrl K</kbd>
      </button>
      {creating && (
        <NewChat
          agents={agents}
          onDone={(rec) => {
            setCreating(false);
            if (rec) onSelect(rec.id);
          }}
        />
      )}
      {error && (
        <button className="sidebar-error" role="alert" title="Dismiss" onClick={() => setError('')}>
          {error}
        </button>
      )}
      <div className="tree" role="tree" aria-label="Agents" onKeyDown={treeKeys}>
        {needs.length > 0 && (
          <>
            <div className="group-label">Needs you</div>
            {needs.map((a) => (
              <Row key={`needs-${a.id}`} {...rowProps(a)} meta={clock(a.lastActivityAt)} />
            ))}
          </>
        )}
        <div className="group-label">Chats</div>
        {orchestrators.length === 0 && !creating && (
          <div className="tree-empty">
            No {archivedChats.length ? 'open chats' : 'agents yet'}.{' '}
            <button className="link-button" onClick={() => setCreating(true)}>
              Start a chat
            </button>
          </div>
        )}
        {orchestrators.map((o) => chatGroup(o, false))}
        {archivedChats.length > 0 && (
          <div className="archived-chats">
            <GroupToggle
              label={`Archived · ${archivedChats.length} chat${archivedChats.length === 1 ? '' : 's'}`}
              open={archivedChatsOpen}
              onToggle={() => treeState.set('archived:chats', !archivedChatsOpen)}
            />
            {archivedChatsOpen && archivedChats.map((o) => chatGroup(o, true))}
          </div>
        )}
      </div>
      <div className="sidebar-foot">
        {running > 0 && (
          <span>
            <span className="foot-dot running" />
            {running} running
          </span>
        )}
        {needs.length > 0 && (
          <span>
            <span className="foot-dot waiting" />
            {needs.length} need{needs.length === 1 ? 's' : ''} you
          </span>
        )}
        {running === 0 && needs.length === 0 && <span>All quiet</span>}
        <span className="foot-spend mono" title="Total spend of all agents">
          {money(spend)}
        </span>
      </div>
      {menu && menuAgent && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button
            role="menuitem"
            onClick={() => {
              setMenu(null);
              onSelect(menuAgent.id);
            }}
          >
            Open
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setMenu(null);
              onOpenInSplit(menuAgent.id);
            }}
          >
            Open in split
            <span className="menu-hint">Or drag the row onto the main area</span>
          </button>
          {menuAgent.kind === 'orchestrator' && (
            <button
              role="menuitem"
              onClick={() => {
                setMenu(null);
                openNewExpert(menuAgent.id);
              }}
            >
              New expert
              <span className="menu-hint">Starts an expert under this chat without telling it</span>
            </button>
          )}
          <button
            role="menuitem"
            disabled={menuBlocker !== null}
            title={menuBlocker ?? undefined}
            onClick={() => {
              setMenu(null);
              void archive(menuAgent);
            }}
          >
            {menuAgent.archived ? 'Unarchive' : 'Archive'}
            {menuBlocker ? (
              <span className="menu-hint">{menuBlocker}</span>
            ) : (
              !menuAgent.archived && menuAgent.kind === 'orchestrator' && <span className="menu-hint">Takes its experts with it</span>
            )}
          </button>
        </ContextMenu>
      )}
    </div>
  );
}

/** A right-click menu at the pointer, kept inside the window. Closes on Escape, a click outside or scrolling. */
function ContextMenu({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
    el.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close.current();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close.current();
    };
    const onAway = () => close.current();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onAway);
    window.addEventListener('resize', onAway);
    document.addEventListener('scroll', onAway, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onAway);
      window.removeEventListener('resize', onAway);
      document.removeEventListener('scroll', onAway, true);
    };
  }, []);

  return (
    <div ref={ref} className="menu context-menu" role="menu" style={pos}>
      {children}
    </div>
  );
}

function GroupToggle({ label, open, parentId, onToggle }: { label: string; open: boolean; parentId?: string; onToggle: () => void }) {
  return (
    <div
      className="tree-row archived-toggle"
      role="treeitem"
      tabIndex={-1}
      data-parent={parentId}
      aria-expanded={open}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <ArchiveIcon size={14} />
      <span>{label}</span>
      <Chevron open={open} size={13} />
    </div>
  );
}

/** Arrow keys move through the tree; Left goes to the parent or collapses, Right expands. */
function treeKeys(e: KeyboardEvent<HTMLDivElement>) {
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[role=treeitem]')];
  const current = (e.target as HTMLElement).closest<HTMLElement>('[role=treeitem]');
  if (!current) return;
  const i = rows.indexOf(current);
  const focus = (el: HTMLElement | undefined) => {
    if (!el) return;
    e.preventDefault();
    el.focus();
  };
  switch (e.key) {
    case 'ArrowDown':
      return focus(rows[i + 1]);
    case 'ArrowUp':
      return focus(rows[i - 1]);
    case 'Home':
      return focus(rows[0]);
    case 'End':
      return focus(rows.at(-1));
    case 'ArrowRight':
      if (current.getAttribute('aria-expanded') === 'false') {
        e.preventDefault();
        current.querySelector<HTMLElement>('.expander')?.click();
      }
      return;
    case 'ArrowLeft': {
      if (current.getAttribute('aria-expanded') === 'true') {
        e.preventDefault();
        current.querySelector<HTMLElement>('.expander')?.click();
        return;
      }
      const parent = current.dataset.parent;
      if (parent) focus(rows.find((r) => r.dataset.id === parent && !r.dataset.parent));
    }
  }
}

type RowProps = {
  agent: AgentRecord;
  state: AgentState;
  selected: boolean;
  /** Shown in the other pane of a split. */
  onScreen?: boolean;
  onSelect: (id: string) => void;
  parentId?: string;
  /** Replaces the status line (the collapsed roll-up). */
  line?: string;
  /** Extra text after the status line. */
  extra?: string;
  /** Right-aligned meta, e.g. the time in Needs you. */
  meta?: string;
  expander?: { open: boolean; toggle: () => void };
  dim?: boolean;
  /** Why the archive button is disabled, if it is. */
  archiveBlocked: string | null;
  onArchive: () => void;
  onMenu: (e: ReactMouseEvent) => void;
};

function Row({ agent, state, selected, onScreen, onSelect, parentId, line, extra, meta, expander, dim, archiveBlocked, onArchive, onMenu }: RowProps) {
  const info = useServerInfo();
  const folder = folderName(agent.cwd);
  // Chats show their folder only when it isn't the default one.
  const showFolder = agent.kind === 'expert' || (info !== null && !sameFolder(agent.cwd, info.orchestratorFolder, info.platform));
  const title = [`${agent.name} (${agent.kind === 'expert' ? 'expert' : 'chat'})`, agent.cwd, agent.lastError && state.key === 'failed' ? agent.lastError.slice(0, 300) : '']
    .filter(Boolean)
    .join('\n');
  const statusLine = line ?? state.line;
  const archiveLabel = agent.archived ? 'Unarchive' : agent.kind === 'orchestrator' ? 'Archive the chat and its experts' : 'Archive';
  return (
    <div
      className={`tree-row agent-row state-${state.key}${selected ? ' selected' : ''}${onScreen ? ' on-screen' : ''}${dim || state.key === 'stopped' ? ' dim' : ''}`}
      role="treeitem"
      tabIndex={selected ? 0 : -1}
      aria-selected={selected}
      aria-expanded={expander?.open}
      aria-current={selected ? 'page' : undefined}
      data-id={agent.id}
      data-parent={parentId}
      title={title}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, agent.id);
        e.dataTransfer.setData('text/plain', agent.name);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onContextMenu={onMenu}
      onClick={() => onSelect(agent.id)}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
          e.preventDefault();
          onSelect(agent.id);
        }
      }}
    >
      <AgentMark agent={agent} state={state.key} />
      <span className="row-text">
        <span className="row-title">
          <span className="row-name">{agent.name}</span>
          {showFolder && <span className="row-folder">{folder}</span>}
        </span>
        <span className="row-status">
          {statusLine}
          {extra && <span className="row-extra"> · {extra}</span>}
        </span>
      </span>
      {meta && <span className="row-meta mono">{meta}</span>}
      <button
        className="row-action"
        tabIndex={-1}
        disabled={archiveBlocked !== null}
        aria-label={`${agent.archived ? 'Unarchive' : 'Archive'} ${agent.name}`}
        title={archiveBlocked ?? archiveLabel}
        onClick={(e) => {
          e.stopPropagation();
          onArchive();
        }}
      >
        <ArchiveIcon size={14} />
      </button>
      {expander && (
        <button
          className="expander"
          tabIndex={-1}
          aria-label={expander.open ? 'Collapse' : 'Expand'}
          onClick={(e) => {
            e.stopPropagation();
            expander.toggle();
          }}
        >
          <Chevron open={expander.open} size={14} />
        </button>
      )}
    </div>
  );
}

function LogoIcon() {
  return (
    <svg className="logo" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="5" cy="12" r="2.5" />
      <circle cx="19" cy="5" r="2.5" />
      <circle cx="19" cy="19" r="2.5" />
      <path d="M7.5 12h4M11.5 12V7c0-1.1.9-2 2-2h3M11.5 12v5c0 1.1.9 2 2 2h3" />
    </svg>
  );
}

/**
 * A new expert under a chat, started by the user. The chat isn't told; the user asks it to read the
 * expert's output when they want that. The folder comes from the recent ones or is typed.
 */
function NewExpert({ chat, agents, onDone }: { chat: AgentRecord; agents: Map<string, AgentRecord>; onDone: (rec: AgentRecord | null) => void }) {
  const recents = recentFolders(agents);
  const lastHere = [...agents.values()].filter((a) => a.parentId === chat.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const [name, setName] = useState('');
  const [folder, setFolder] = useState(() => lastHere?.cwd ?? recents[0] ?? chat.cwd);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => nameRef.current?.focus(), []);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!name.trim() || !folder.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const rec = await commands.createExpert(chat.id, { name: name.trim(), cwd: folder.trim(), message: message.trim() || undefined });
      store.upsert(rec);
      onDone(rec);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <form
      className="new-chat new-expert"
      aria-label={`New expert under ${chat.name}`}
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onDone(null);
        }
      }}
    >
      <div className="form-title">New expert under {chat.name}</div>
      <input ref={nameRef} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="mono" placeholder="Folder (absolute path)" value={folder} spellCheck={false} onChange={(e) => setFolder(e.target.value)} />
      {recents.length > 0 && (
        <div className="recent-folders" role="listbox" aria-label="Recent folders">
          {recents.slice(0, 6).map((dir) => (
            <button
              type="button"
              key={dir}
              role="option"
              aria-selected={dir === folder.trim()}
              className={`recent-folder${dir === folder.trim() ? ' selected' : ''}`}
              title={dir}
              onClick={() => setFolder(dir)}
            >
              <span className="recent-name">{folderName(dir)}</span>
              <span className="recent-path mono">{dir}</span>
            </button>
          ))}
        </div>
      )}
      <textarea
        placeholder="First message (optional)"
        rows={3}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if ((e.shiftKey && continueList(e)) || indentList(e)) return;
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="hint">{chat.name} isn't told. Ask it to read the expert's output when you want it to.</div>
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        <button type="button" className="button secondary small" onClick={() => onDone(null)}>
          Cancel
        </button>
        <button type="submit" className="button primary small" disabled={!name.trim() || !folder.trim() || busy}>
          Start
        </button>
      </div>
    </form>
  );
}

/**
 * A new chat: a name and the folder it runs in. The folder is a quiet line with the default folder; clicking it
 * opens a path field with the recent folders. The first message goes in the chat's own composer.
 */
function NewChat({ agents, onDone }: { agents: Map<string, AgentRecord>; onDone: (rec: AgentRecord | null) => void }) {
  const info = useServerInfo();
  const [name, setName] = useState('');
  const [folder, setFolder] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => nameRef.current?.focus(), []);

  const defaultFolder = info?.orchestratorFolder ?? '';
  const shown = folder ?? defaultFolder;
  const same = (a: string, b: string) => sameFolder(a, b, info?.platform);
  // The default first, then other chats' folders, then experts' (each newest first).
  const choices = defaultFolder ? [defaultFolder, ...recentChatFolders(agents).filter((d) => !same(d, defaultFolder))].slice(0, 6) : [];

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!name.trim() || !shown.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const cwd = shown.trim();
      const rec = await commands.createChat(name.trim(), defaultFolder && same(cwd, defaultFolder) ? undefined : cwd);
      store.upsert(rec);
      onDone(rec);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <form
      className="new-chat"
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onDone(null);
      }}
    >
      <div className="form-title">New chat</div>
      <input ref={nameRef} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
      {!editing ? (
        <button
          type="button"
          className="folder-toggle"
          title={`${shown}\nClick to run the chat in another folder`}
          disabled={!shown}
          onClick={() => setEditing(true)}
        >
          in <span className="mono">{shown ? folderName(shown) : '…'}</span>
        </button>
      ) : (
        <input
          autoFocus
          className="mono"
          placeholder="Folder (absolute path)"
          aria-label="Folder"
          value={shown}
          spellCheck={false}
          onChange={(e) => setFolder(e.target.value)}
        />
      )}
      {editing && choices.length > 1 && (
        <div className="recent-folders" role="listbox" aria-label="Folders">
          {choices.map((dir) => (
            <button
              type="button"
              key={dir}
              role="option"
              aria-selected={same(dir, shown)}
              className={`recent-folder${same(dir, shown) ? ' selected' : ''}`}
              title={dir}
              onClick={() => setFolder(dir)}
            >
              <span className="recent-name">
                {folderName(dir)}
                {dir === defaultFolder ? ' (default)' : ''}
              </span>
              <span className="recent-path mono">{dir}</span>
            </button>
          ))}
        </div>
      )}
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        <button type="button" className="button secondary small" onClick={() => onDone(null)}>
          Cancel
        </button>
        <button type="submit" className="button primary small" disabled={!name.trim() || !shown.trim() || busy}>
          Start
        </button>
      </div>
    </form>
  );
}
