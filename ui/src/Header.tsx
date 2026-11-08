import { useEffect, useRef, useState } from 'react';
import { commands, type AgentRecord } from './api';
import { permissionNote } from './AlertsMenu';
import { CacheTag } from './CacheTag';
import { alertDefault, alertsOn, askPermission, setAgentAlerts, useAlertPermission, useAlertSettings } from './desktopNotify';
import { useNow } from './hooks';
import { CloseIcon, FolderIcon, MenuIcon, MoreIcon } from './icons';
import { AgentMark, StateDot } from './Mark';
import { ModelPicker } from './ModelPicker';
import { agentState, archiveBlocker, folderName, money } from './status';
import { lastSeen, openNewExpert, useManager } from './store';

type Props = {
  agent: AgentRecord;
  parent: AgentRecord | undefined;
  agents: Map<string, AgentRecord>;
  run: (a: () => Promise<unknown>) => Promise<void>;
  onSelect: (id: string) => void;
  /** Close this pane of a split. */
  onClose?: () => void;
  onOpenDrawer?: () => void;
  filesOpen: boolean;
  onToggleFiles: () => void;
};

/** Two lines: the breadcrumb as the title with the agent's tools, then its status as a sentence. */
export function Header({ agent, parent, agents, run, onSelect, onClose, onOpenDrawer, filesOpen, onToggleFiles }: Props) {
  const { activity } = useManager();
  const seen = lastSeen.use();
  const [menu, setMenu] = useState(false);
  const alertSettings = useAlertSettings();
  const alertPermission = useAlertPermission();
  const alerts = alertsOn(agent, alertSettings);
  const menuRef = useRef<HTMLDivElement>(null);
  const blocker = archiveBlocker(agent, agents);
  const now = useNow(true, agent.status === 'running' ? 1000 : 30_000);
  const state = agentState(agent, agents, seen, activity.get(agent.id), now);
  const parentState = parent ? agentState(parent, agents, seen, activity.get(parent.id), now) : null;

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !menuRef.current?.contains(e.target as Node)) {
        e.stopPropagation();
        setMenu(false);
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close, true);
    };
  }, [menu]);

  const copyPath = () => {
    void navigator.clipboard?.writeText(agent.cwd);
  };

  return (
    <header className="agent-header">
      <div className="header-line">
        {onOpenDrawer && (
          <button className="icon-button" aria-label="Open the agent list" onClick={onOpenDrawer}>
            <MenuIcon size={16} />
          </button>
        )}
        <nav className="breadcrumb" aria-label="Breadcrumb">
          {parent && (
            <>
              <button className="crumb" title={`Back to ${parent.name} (Alt+←)`} onClick={() => onSelect(parent.id)}>
                <AgentMark agent={parent} state={parentState?.key} size={20} />
                <span className="crumb-name">{parent.name}</span>
              </button>
              <span className="crumb-sep" aria-hidden="true">
                /
              </span>
            </>
          )}
          <span className="crumb current">
            <AgentMark agent={agent} size={24} />
            <h1>{agent.name}</h1>
          </span>
          {agent.archived && <span className="tag">archived</span>}
        </nav>
        <div className="header-tools">
          <ModelPicker agent={agent} run={run} />
          <button
            className={`chip mono files-chip${filesOpen ? ' on' : ''}`}
            title={`${agent.cwd}\n${filesOpen ? 'Close' : 'Show'} the files (Ctrl+B)`}
            aria-pressed={filesOpen}
            onClick={onToggleFiles}
          >
            <FolderIcon size={13} />
            <span className="chip-label">{folderName(agent.cwd)}</span>
          </button>
          <span className="mono header-cost" title="Total cost of this agent">
            {money(agent.costUsd)}
          </span>
          <ContextRing agent={agent} />
          <CacheTag agent={agent} run={run} />
          <div className="menu-anchor" ref={menuRef}>
            <button className="icon-button" title="More actions" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
              <MoreIcon size={16} />
            </button>
            {menu && (
              <div className="menu" role="menu">
                {agent.kind === 'orchestrator' && !agent.archived && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      openNewExpert(agent.id);
                      onOpenDrawer?.();
                    }}
                  >
                    New expert
                    <span className="menu-hint">Starts an expert under this chat without telling it</span>
                  </button>
                )}
                {agent.kind === 'orchestrator' && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      void run(() => commands.setNotificationsPaused(agent.id, !agent.notificationsPaused));
                    }}
                  >
                    {agent.notificationsPaused ? 'Resume expert notifications' : 'Pause expert notifications'}
                    <span className="menu-hint">
                      {agent.notificationsPaused
                        ? 'Delivers the held ones as one message'
                        : 'Holds them until you resume, then they arrive together'}
                    </span>
                  </button>
                )}
                <button
                  role="menuitem"
                  disabled={alertPermission === 'unsupported'}
                  onClick={() => {
                    setMenu(false);
                    if (alerts && alertPermission === 'default') void askPermission();
                    else setAgentAlerts(agent, !alerts);
                  }}
                >
                  {alerts && alertPermission === 'default' ? 'Allow desktop alerts' : alerts ? 'Turn off desktop alerts' : 'Turn on desktop alerts'}
                  <span className="menu-hint">
                    {alerts && alertPermission !== 'granted'
                      ? permissionNote(alertPermission)
                      : `System notifications when ${agent.parentId === null ? 'its turn ends' : 'it finishes'} or it needs you, while the window is in the background${
                          alerts === alertDefault(agent, alertSettings) ? ` (the default for ${agent.parentId === null ? 'chats' : 'experts'})` : ''
                        }`}
                  </span>
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    copyPath();
                  }}
                >
                  Copy folder path
                  <span className="menu-hint mono">{agent.cwd}</span>
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    openInVsCode(agent.cwd);
                  }}
                >
                  Open folder in VS Code
                  <span className="menu-hint">Opens the agent's folder in a VS Code window</span>
                </button>
                <button
                  role="menuitem"
                  disabled={blocker !== null}
                  title={blocker ?? undefined}
                  onClick={() => {
                    setMenu(false);
                    void run(() => commands.setArchived(agent.id, !agent.archived));
                  }}
                >
                  {agent.archived ? 'Unarchive' : 'Archive'}
                  {!agent.archived && agent.kind === 'orchestrator' && <span className="menu-hint">Moves the chat and its experts to Archived</span>}
                </button>
                <button
                  role="menuitem"
                  className="danger"
                  onClick={() => {
                    setMenu(false);
                    void run(() => commands.stop(agent.id));
                  }}
                >
                  Stop agent
                  <span className="menu-hint">Cancels the turn, clears the queue and closes the process</span>
                </button>
              </div>
            )}
          </div>
          {onClose && (
            <button className="icon-button" title="Close this pane" aria-label="Close this pane" onClick={onClose}>
              <CloseIcon size={16} />
            </button>
          )}
        </div>
      </div>
      <div className={`header-status state-${state.key}`}>
        <StateDot state={state.key} />
        <span>{state.sentence}</span>
      </div>
    </header>
  );
}

/** VS Code's own link handler opens a folder too; the browser asks once before handing the link over. */
function openInVsCode(folder: string): void {
  const p = folder.replace(/\\/g, '/');
  const a = document.createElement('a');
  a.href = `vscode://file/${encodeURI(p.startsWith('/') ? p.slice(1) : p)}`;
  a.click();
}

/** Context in use after the last turn: a ring that turns amber from 70 % and coral from 85 %. */
function ContextRing({ agent }: { agent: AgentRecord }) {
  const ctx = agent.context;
  const pct = ctx && ctx.windowTokens ? Math.min(100, Math.round((ctx.usedTokens / ctx.windowTokens) * 100)) : null;
  const level = pct === null ? '' : pct >= 85 ? ' high' : pct >= 70 ? ' warn' : '';
  const c = 2 * Math.PI * 6;
  return (
    <span
      className={`context-ring mono${level}`}
      title={
        ctx
          ? `Context after the last turn: ${ctx.usedTokens.toLocaleString()} of ${ctx.windowTokens.toLocaleString()} tokens`
          : 'Context use is known after the first turn'
      }
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6" className="ring-track" />
        {pct !== null && pct > 0 && (
          <circle cx="8" cy="8" r="6" className="ring-value" strokeDasharray={`${(pct / 100) * c} ${c}`} transform="rotate(-90 8 8)" />
        )}
      </svg>
      {pct === null ? '–' : `${pct}%`}
    </span>
  );
}
