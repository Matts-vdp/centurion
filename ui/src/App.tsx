import { useCallback, useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { AgentRecord } from './api';
import { AgentView } from './AgentView';
import { useMedia } from './hooks';
import { CloseIcon, MenuIcon } from './icons';
import { DRAG_TYPE, layout, useLayout, type DropZone } from './layout';
import { AgentMark } from './Mark';
import { Sidebar } from './Sidebar';
import { store, useManager } from './store';
import { Switcher } from './Switcher';

const NARROW = '(max-width: 899px)';

function readHash(): string | null {
  const m = /^#agent=(.+)$/.exec(location.hash);
  return m ? decodeURIComponent(m[1]) : null;
}

function writeHash(id: string | null): void {
  const want = id ? `#agent=${encodeURIComponent(id)}` : '';
  if (location.hash !== want) history.replaceState(null, '', `${location.pathname}${location.search}${want}`);
}

// A link (#agent=…) opens that agent in the focused pane.
const initial = readHash();
if (initial) layout.open(initial);

export function App() {
  const { agents, connected, authError, epoch } = useManager();
  const { panes, focus, ratio } = useLayout();
  const selected = panes[focus] ?? null;
  const narrow = useMedia(NARROW);
  const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia(NARROW).matches || !layout.focused());
  const [switcher, setSwitcher] = useState(false);

  useEffect(() => store.connect(), []);
  useEffect(() => {
    const on = () => {
      const id = readHash();
      if (id) layout.open(id);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  // The hash follows the focused pane, so a reload or a shared link opens the same agent.
  useEffect(() => writeHash(selected), [selected]);

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
      layout.open(id);
      if (narrow) setSidebarOpen(false);
    },
    [narrow],
  );
  const openInSplit = useCallback(
    (id: string) => {
      layout.openInSplit(id);
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
  // Narrow widths show only the focused pane, with a switch between the two.
  const split = panes.length === 2 && !narrow;

  return (
    <div className={`app${narrow ? ' narrow' : ''}`}>
      {showSidebar && (
        <>
          {narrow && agent && <div className="scrim" onClick={() => setSidebarOpen(false)} />}
          <aside className="sidebar" aria-label="Agents">
            <Sidebar agents={agents} selected={selected} open={panes} onSelect={select} onOpenInSplit={openInSplit} onSearch={() => setSwitcher(true)} />
          </aside>
        </>
      )}
      <Main split={split}>
        {!connected && epoch > 0 && <div className="banner">Connection lost. Reconnecting…</div>}
        {authError && <div className="banner error">The manager refused the token. Open the URL the manager printed (it ends in ?token=…).</div>}
        {narrow && panes.length === 2 && <PaneSwitch panes={panes} focus={focus} agents={agents} />}
        {panes.length === 0 || (narrow && !agent) ? (
          <Welcome narrow={narrow} showSidebar={showSidebar} onOpenDrawer={() => setSidebarOpen(true)} state={epoch === 0 && !authError ? 'connecting' : selected ? 'gone' : 'empty'} />
        ) : (
          <div className={`panes${split ? ' split' : ''}`}>
            {panes.map((id, i) => {
              if (!split && i !== focus) return null;
              const a = agents.get(id);
              return (
                <Pane key={`${i}:${id}`} index={i} focused={i === focus} split={split} width={split ? (i === 0 ? ratio : 1 - ratio) : 1}>
                  {a ? (
                    <AgentView
                      key={a.id}
                      agent={a}
                      agents={agents}
                      epoch={epoch}
                      pane={i}
                      focused={i === focus}
                      onSelect={select}
                      onClose={split ? () => layout.close(i) : undefined}
                      onOpenDrawer={showSidebar || (split && i === 1) ? undefined : openDrawer}
                    />
                  ) : (
                    <Welcome
                      narrow={narrow}
                      showSidebar={showSidebar}
                      onOpenDrawer={() => setSidebarOpen(true)}
                      state={epoch === 0 && !authError ? 'connecting' : 'gone'}
                      onClose={panes.length === 2 ? () => layout.close(i) : undefined}
                    />
                  )}
                </Pane>
              );
            })}
            {split && <Divider />}
          </div>
        )}
      </Main>
      {switcher && <Switcher agents={agents} onSelect={select} onSplit={openInSplit} onClose={() => setSwitcher(false)} />}
    </div>
  );
}

/** The main area. A sidebar row dragged over it shows where it would land. */
function Main({ split, children }: { split: boolean; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const [zone, setZone] = useState<DropZone | null>(null);
  const { panes } = useLayout();

  // A drag that ends anywhere (dropped elsewhere, or Esc) clears the overlay.
  useEffect(() => {
    if (!zone) return;
    const clear = () => setZone(null);
    window.addEventListener('dragend', clear);
    window.addEventListener('drop', clear);
    return () => {
      window.removeEventListener('dragend', clear);
      window.removeEventListener('drop', clear);
    };
  }, [zone]);

  const zoneAt = (e: DragEvent): DropZone => {
    const r = ref.current!.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    if (panes.length === 0) return 'replace';
    // Split: each half replaces its pane. Single: the outer thirds split, the middle replaces.
    if (split || panes.length === 2) return x < 0.5 ? 'left' : 'right';
    return x < 1 / 3 ? 'left' : x > 2 / 3 ? 'right' : 'replace';
  };

  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const z = zoneAt(e);
    if (z !== zone) setZone(z);
  };

  const onDrop = (e: DragEvent) => {
    const id = e.dataTransfer.getData(DRAG_TYPE);
    setZone(null);
    if (!id) return;
    e.preventDefault();
    layout.drop(id, zoneAt(e));
  };

  const label =
    zone === 'replace'
      ? 'Open here'
      : panes.length === 2 || split
        ? `Open on the ${zone}`
        : `Split · open on the ${zone}`;

  return (
    <main
      ref={ref}
      className="main"
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!ref.current?.contains(e.relatedTarget as Node | null)) setZone(null);
      }}
      onDrop={onDrop}
    >
      {children}
      {zone && (
        <div className="drop-overlay" aria-hidden="true">
          <div className={`drop-zone ${zone}${panes.length === 2 || split ? ' half' : ''}`}>
            <span>{label}</span>
          </div>
        </div>
      )}
    </main>
  );
}

function Pane({ index, focused, split, width, children }: { index: number; focused: boolean; split: boolean; width: number; children: ReactNode }) {
  return (
    <section
      className={`pane${focused ? ' focused' : ''}`}
      style={split ? { flexBasis: `${width * 100}%` } : undefined}
      onMouseDownCapture={() => layout.setFocus(index)}
      onFocusCapture={() => layout.setFocus(index)}
    >
      {children}
    </section>
  );
}

/** Drag to resize the split; double-click puts it back in the middle. */
function Divider() {
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const host = e.currentTarget.parentElement!;
    const rect = host.getBoundingClientRect();
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => layout.setRatio((ev.clientX - rect.left) / rect.width);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
    };
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const { ratio } = layout.get();
  return (
    <div
      className="pane-divider"
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={Math.round(ratio * 100)}
      aria-label="Resize the panes"
      tabIndex={0}
      style={{ left: `${ratio * 100}%` }}
      onPointerDown={onPointerDown}
      onDoubleClick={() => layout.setRatio(0.5)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          layout.setRatio(ratio + (e.key === 'ArrowLeft' ? -0.05 : 0.05));
        }
      }}
    />
  );
}

/** Narrow widths: one pane at a time, with a switch between the two. */
function PaneSwitch({ panes, focus, agents }: { panes: string[]; focus: number; agents: Map<string, AgentRecord> }) {
  return (
    <div className="pane-switch" role="tablist" aria-label="Open agents">
      {panes.map((id, i) => {
        const a = agents.get(id);
        return (
          <button key={`${i}:${id}`} role="tab" aria-selected={i === focus} className={i === focus ? 'active' : ''} onClick={() => layout.setFocus(i)}>
            {a && <AgentMark agent={a} size={18} />}
            <span>{a?.name ?? 'Gone'}</span>
          </button>
        );
      })}
      <button className="icon-button" aria-label="Close this pane" title="Close this pane" onClick={() => layout.close(focus)}>
        <CloseIcon size={14} />
      </button>
    </div>
  );
}

function Welcome({
  narrow,
  showSidebar,
  onOpenDrawer,
  state,
  onClose,
}: {
  narrow: boolean;
  showSidebar: boolean;
  onOpenDrawer: () => void;
  state: 'connecting' | 'gone' | 'empty';
  onClose?: () => void;
}) {
  return (
    <div className="welcome">
      {narrow && !showSidebar && (
        <button className="icon-button drawer-button" aria-label="Open the agent list" onClick={onOpenDrawer}>
          <MenuIcon size={16} />
        </button>
      )}
      {state === 'connecting' ? (
        <p>Connecting to the agent manager…</p>
      ) : state === 'gone' ? (
        <p>
          That agent no longer exists. Pick one from the sidebar.
          {onClose && (
            <>
              {' '}
              <button className="link-button" onClick={onClose}>
                Close this pane
              </button>
            </>
          )}
        </p>
      ) : (
        <>
          <h1>Agent manager</h1>
          <p>Pick an agent in the sidebar, or start a new chat with the + button. Drag a second one onto this area to see them side by side.</p>
        </>
      )}
    </div>
  );
}
