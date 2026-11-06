import { useCallback, useEffect, useState } from 'react';
import { AgentView } from './AgentView';
import { AgentsIcon } from './icons';
import { Sidebar } from './Sidebar';
import { store, useManager } from './store';

const NARROW = '(max-width: 720px)';

function readHash(): string | null {
  const m = /^#agent=(.+)$/.exec(location.hash);
  return m ? decodeURIComponent(m[1]) : null;
}

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

export function App() {
  const { agents, connected, authError, epoch } = useManager();
  const [selected, setSelected] = useState<string | null>(readHash);
  const narrow = useMedia(NARROW);
  const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia(NARROW).matches || !readHash());

  useEffect(() => store.connect(), []);
  useEffect(() => {
    const on = () => setSelected(readHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
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

  return (
    <div className={`app${narrow ? ' narrow' : ''}`}>
      <nav className="activitybar" aria-label="Views">
        <button
          className={`activity${showSidebar ? ' active' : ''}`}
          title="Agents"
          aria-pressed={showSidebar}
          onClick={() => setSidebarOpen((open) => !(open || (narrow && !agent)))}
        >
          <AgentsIcon size={22} />
        </button>
      </nav>
      {showSidebar && (
        <>
          {narrow && agent && <div className="scrim" onClick={() => setSidebarOpen(false)} />}
          <aside className="sidebar">
            <Sidebar agents={agents} selected={selected} onSelect={select} />
          </aside>
        </>
      )}
      <main className="main">
        {!connected && epoch > 0 && <div className="banner">Connection lost. Reconnecting…</div>}
        {authError && <div className="banner error">The manager refused the token. Open the URL the manager printed (it ends in ?token=…).</div>}
        {agent ? (
          <AgentView key={agent.id} agent={agent} agents={agents} epoch={epoch} onSelect={select} />
        ) : (
          <div className="welcome">
            {epoch === 0 && !authError ? (
              <p>Connecting to the agent manager…</p>
            ) : selected ? (
              <p>That agent no longer exists. Pick one from the sidebar.</p>
            ) : (
              <>
                <h1>Agent manager</h1>
                <p>Pick an agent in the sidebar, or start a new orchestrator with the + button.</p>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
