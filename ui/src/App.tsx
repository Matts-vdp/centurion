import { useCallback, useEffect, useState } from 'react';
import { AgentView } from './AgentView';
import { useMedia } from './hooks';
import { MenuIcon } from './icons';
import { Sidebar } from './Sidebar';
import { store, useManager } from './store';
import { Switcher } from './Switcher';

const NARROW = '(max-width: 899px)';

function readHash(): string | null {
  const m = /^#agent=(.+)$/.exec(location.hash);
  return m ? decodeURIComponent(m[1]) : null;
}

export function App() {
  const { agents, connected, authError, epoch } = useManager();
  const [selected, setSelected] = useState<string | null>(readHash);
  const narrow = useMedia(NARROW);
  const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia(NARROW).matches || !readHash());
  const [switcher, setSwitcher] = useState(false);

  useEffect(() => store.connect(), []);
  useEffect(() => {
    const on = () => setSelected(readHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  // Ctrl+K (or Cmd+K) opens the switcher from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSwitcher((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const select = useCallback(
    (id: string) => {
      if (location.hash !== `#agent=${encodeURIComponent(id)}`) location.hash = `agent=${encodeURIComponent(id)}`;
      setSelected(id);
      if (narrow) setSidebarOpen(false);
    },
    [narrow],
  );

  const agent = selected ? agents.get(selected) : undefined;

  // Wide: the sidebar comes back. Narrow: it becomes a drawer, closed while an agent is open.
  // `selected` rather than `agent`: the agent list may not have arrived yet on first load.
  const hasAgent = selected !== null;
  useEffect(() => {
    setSidebarOpen(!narrow || !hasAgent);
    // Only when the width class changes, not on every selection.
  }, [narrow]);
  const showSidebar = sidebarOpen || (narrow && !agent);
  const openDrawer = narrow ? () => setSidebarOpen(true) : undefined;

  return (
    <div className={`app${narrow ? ' narrow' : ''}`}>
      {showSidebar && (
        <>
          {narrow && agent && <div className="scrim" onClick={() => setSidebarOpen(false)} />}
          <aside className="sidebar" aria-label="Agents">
            <Sidebar agents={agents} selected={selected} onSelect={select} onSearch={() => setSwitcher(true)} />
          </aside>
        </>
      )}
      <main className="main">
        {!connected && epoch > 0 && <div className="banner">Connection lost. Reconnecting…</div>}
        {authError && <div className="banner error">The manager refused the token. Open the URL the manager printed (it ends in ?token=…).</div>}
        {agent ? (
          <AgentView key={agent.id} agent={agent} agents={agents} epoch={epoch} onSelect={select} onOpenDrawer={showSidebar ? undefined : openDrawer} />
        ) : (
          <div className="welcome">
            {narrow && !showSidebar && (
              <button className="icon-button drawer-button" aria-label="Open the agent list" onClick={() => setSidebarOpen(true)}>
                <MenuIcon size={16} />
              </button>
            )}
            {epoch === 0 && !authError ? (
              <p>Connecting to the agent manager…</p>
            ) : selected ? (
              <p>That agent no longer exists. Pick one from the sidebar.</p>
            ) : (
              <>
                <h1>Agent manager</h1>
                <p>Pick an agent in the sidebar, or start a new chat with the + button.</p>
              </>
            )}
          </div>
        )}
      </main>
      {switcher && <Switcher agents={agents} onSelect={select} onClose={() => setSwitcher(false)} />}
    </div>
  );
}
