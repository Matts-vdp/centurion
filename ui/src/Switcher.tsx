import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentRecord } from './api';
import { SearchIcon } from './icons';
import { AgentMark } from './Mark';
import { agentState, folderName } from './status';
import { lastSeen, useManager } from './store';

/** Ctrl+K: jump to any agent by name, folder or orchestrator. */
export function Switcher({ agents, onSelect, onClose }: { agents: Map<string, AgentRecord>; onSelect: (id: string) => void; onClose: () => void }) {
  const { activity } = useManager();
  const seen = lastSeen.use();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const now = Date.now();

  useEffect(() => input.current?.focus(), []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = [...agents.values()].sort((a, b) => Number(a.archived) - Number(b.archived) || b.lastActivityAt.localeCompare(a.lastActivityAt));
    if (!q) return all;
    return all.filter((a) => {
      const parent = a.parentId ? agents.get(a.parentId)?.name ?? '' : '';
      return [a.name, folderName(a.cwd), parent].some((s) => s.toLowerCase().includes(q));
    });
  }, [agents, query]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const pick = (a: AgentRecord | undefined) => {
    if (!a) return;
    onSelect(a.id);
    onClose();
  };

  return (
    <div className="switcher-scrim" onMouseDown={onClose}>
      <div className="switcher" role="dialog" aria-label="Jump to an agent" onMouseDown={(e) => e.stopPropagation()}>
        <div className="switcher-input">
          <SearchIcon size={16} />
          <input
            ref={input}
            value={query}
            placeholder="Jump to an agent…"
            aria-controls="switcher-list"
            aria-activedescendant={matches[index] ? `switch-${matches[index].id}` : undefined}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, matches.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                pick(matches[index]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onClose();
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="switcher-list" id="switcher-list" role="listbox" ref={list}>
          {matches.length === 0 && <div className="switcher-empty">No agent matches “{query}”.</div>}
          {matches.map((a, i) => {
            const st = agentState(a, agents, seen, activity.get(a.id), now);
            const parent = a.parentId ? agents.get(a.parentId) : undefined;
            return (
              <div
                key={a.id}
                id={`switch-${a.id}`}
                data-index={i}
                role="option"
                aria-selected={i === index}
                className={`switcher-item${i === index ? ' active' : ''}${a.archived ? ' dim' : ''}`}
                onMouseMove={() => setIndex(i)}
                onClick={() => pick(a)}
              >
                <AgentMark agent={a} state={st.key} size={22} />
                <span className="switcher-name">{a.name}</span>
                <span className="mono switcher-where">
                  {a.kind === 'expert' ? folderName(a.cwd) : 'orchestrator'}
                  {parent ? ` · ${parent.name}` : ''}
                  {a.archived ? ' · archived' : ''}
                </span>
                <span className="switcher-status">{st.line}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
