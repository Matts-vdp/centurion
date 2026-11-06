import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { commands, type AgentRecord, type CommandOption, type QueuedMessage } from './api';
import { useNow } from './hooks';
import { CloseIcon, SendIcon } from './icons';
import { agentState } from './status';
import { composerFill, lastSeen, pendingFor, useManager } from './store';
import { parsePrompt } from './timeline';

type Props = {
  agent: AgentRecord;
  agents: Map<string, AgentRecord>;
  /** The focused pane: it takes the keyboard focus and Esc. */
  focused: boolean;
  run: (a: () => Promise<unknown>) => Promise<void>;
  onInterrupt: () => void;
};

/** The floating composer: live status line above it, queued messages inside its top, the message box. */
export function Composer({ agent, agents, focused, run, onInterrupt }: Props) {
  const [text, setText] = useState(() => readDraft(agent.id));
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const running = agent.status === 'running';
  const { plans, questionSets } = useManager();
  // A plan or a question set waits for the user: the composer says it never carries their state.
  const pending = agent.kind === 'orchestrator' ? pendingFor(agent.id, { plans, questionSets }) : { plan: null, questions: 0 };
  const decision = pending.plan
    ? { placeholder: 'Answer, add context, or ask for a different plan', hint: 'Enter sends just your message, never the checkboxes' }
    : pending.questions
      ? { placeholder: `Message ${agent.name}`, hint: 'Enter sends just your message, never the selected answers' }
      : null;

  // Skill autocomplete: `/` as the first character, before the first space.
  const slash = /^\/(\S*)$/.exec(text);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuClosedAt, setMenuClosedAt] = useState<string | null>(null);
  const skills = useCommands(agent.id, slash !== null);
  const menuOpen = slash !== null && menuClosedAt !== text;
  const matches = menuOpen && skills.list ? matchCommands(skills.list, slash[1]) : [];
  const active = Math.min(menuIndex, Math.max(0, matches.length - 1));
  useEffect(() => setMenuIndex(0), [slash?.[1]]);
  const fillCommand = (c: CommandOption) => {
    setText(`/${c.name} `);
    setMenuClosedAt(null);
    box.current?.focus();
  };

  useEffect(() => writeDraft(agent.id, text), [agent.id, text]);
  // A rewound message comes back here to edit and resend.
  const fill = composerFill.use();
  useEffect(() => {
    if (!fill || fill.agentId !== agent.id) return;
    composerFill.set(null);
    setText(fill.text);
    box.current?.focus();
  }, [fill, agent.id]);
  useEffect(() => {
    if (focused && !document.activeElement?.closest('.pane.focused')) box.current?.focus();
  }, [agent.id, focused]);

  // Grow with the text; CSS caps the height.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  // Esc interrupts the running turn (the queue stays), unless something else handles it.
  useEffect(() => {
    if (!running || !focused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if ((e.target as HTMLElement | null)?.closest('.sidebar, .menu, .switcher')) return;
      e.preventDefault();
      onInterrupt();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running, focused, onInterrupt]);

  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    await run(async () => {
      await commands.send(agent.id, value);
      // Keep anything typed while the request was in flight.
      setText((current) => (current.trim() === value ? '' : current));
    });
    setSending(false);
    box.current?.focus();
  };

  return (
    <div className="composer-dock">
      <div className="composer-column">
        {running && <LiveStatus agent={agent} agents={agents} />}
        <div className="composer">
          {menuOpen && (skills.list === null || matches.length > 0) && (
            <SlashMenu matches={matches} loading={skills.list === null} error={skills.error} active={active} onHover={setMenuIndex} onPick={fillCommand} />
          )}
          {agent.queue.length > 0 && <Queue agent={agent} run={run} />}
          <div className="composer-body">
            <textarea
              ref={box}
              rows={2}
              value={text}
              aria-label={running ? `Queue a message for ${agent.name}` : `Message ${agent.name}`}
              placeholder={running ? `Queue a message for ${agent.name}` : (decision?.placeholder ?? `Message ${agent.name}`)}
              onChange={(e) => setText(e.target.value)}
              aria-autocomplete="list"
              aria-expanded={matches.length > 0}
              aria-controls={matches.length > 0 ? 'slash-menu' : undefined}
              aria-activedescendant={matches.length > 0 ? `slash-${active}` : undefined}
              onKeyDown={(e) => {
                if (matches.length > 0 && !e.nativeEvent.isComposing) {
                  const picked = matches[active];
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    setMenuIndex((active + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
                    return;
                  }
                  if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && text !== `/${picked.name}`)) {
                    e.preventDefault();
                    fillCommand(picked);
                    return;
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setMenuClosedAt(text);
                    return;
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="composer-foot">
              <span className="composer-hint">
                {running ? 'Enter queues it for after this turn' : decision?.hint}
              </span>
              {running && (
                <button className="round-button stop" aria-label="Interrupt the turn (Esc). The queue stays." title="Interrupt the turn (Esc). The queue stays." onClick={onInterrupt}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <rect x="5" y="5" width="14" height="14" rx="2.5" />
                  </svg>
                </button>
              )}
              <button
                className="round-button send"
                disabled={!text.trim() || sending}
                aria-label={running ? 'Queue' : 'Send'}
                title={running ? 'Queue (Enter)' : 'Send (Enter)'}
                onClick={() => void send()}
              >
                <SendIcon size={16} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Skills by agent, fetched when the menu opens and reused for a minute. */
const commandCache = new Map<string, { list: CommandOption[]; at: number }>();

function useCommands(agentId: string, active: boolean): { list: CommandOption[] | null; error: string | null } {
  const [state, setState] = useState<{ id: string; list: CommandOption[] | null; error: string | null }>(() => ({
    id: agentId,
    list: commandCache.get(agentId)?.list ?? null,
    error: null,
  }));
  useEffect(() => {
    if (!active) return;
    const cached = commandCache.get(agentId);
    if (cached) setState({ id: agentId, list: cached.list, error: null });
    if (cached && Date.now() - cached.at < 60_000) return;
    let live = true;
    commands.commands(agentId).then(
      (list) => {
        commandCache.set(agentId, { list, at: Date.now() });
        if (live) setState({ id: agentId, list, error: null });
      },
      (err: unknown) => live && setState({ id: agentId, list: cached?.list ?? [], error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
  }, [agentId, active]);
  return state.id === agentId ? state : { list: commandCache.get(agentId)?.list ?? null, error: null };
}

/** Names starting with the query first, then names containing it, then descriptions containing it. */
function matchCommands(list: CommandOption[], query: string): CommandOption[] {
  const q = query.toLowerCase();
  if (!q) return list;
  const rank = (c: CommandOption) => {
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) return 0;
    if (name.includes(q)) return 1;
    return c.description.toLowerCase().includes(q) ? 2 : -1;
  };
  return list
    .map((c) => ({ c, r: rank(c) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r)
    .map((x) => x.c);
}

type SlashMenuProps = {
  matches: CommandOption[];
  loading: boolean;
  error: string | null;
  active: number;
  onHover: (index: number) => void;
  onPick: (c: CommandOption) => void;
};

function SlashMenu({ matches, loading, error, active, onHover, onPick }: SlashMenuProps) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector(`#slash-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return (
    <div className="slash-menu" id="slash-menu" role="listbox" aria-label="Skills" ref={list}>
      {loading && <div className="slash-note">Loading skills…</div>}
      {error && <div className="slash-note">Could not load the skills: {error}</div>}
      {matches.map((c, n) => (
        <div
          key={c.name}
          id={`slash-${n}`}
          role="option"
          aria-selected={n === active}
          className={`slash-item${n === active ? ' active' : ''}`}
          onMouseEnter={() => onHover(n)}
          onMouseDown={(e) => {
            e.preventDefault(); // keep the focus in the box
            onPick(c);
          }}
        >
          <span className="slash-name mono">
            /{c.name}
            {c.argumentHint && <span className="slash-args"> {c.argumentHint}</span>}
          </span>
          <span className="slash-description">{c.description}</span>
        </div>
      ))}
    </div>
  );
}

/** What the agent is doing right now, with a soft shimmer. */
function LiveStatus({ agent, agents }: { agent: AgentRecord; agents: Map<string, AgentRecord> }) {
  const { activity } = useManager();
  const seen = lastSeen.use();
  const now = useNow(true);
  const state = agentState(agent, agents, seen, activity.get(agent.id), now);
  return (
    <div className={`live-status${state.key === 'needs' ? ' waiting' : ''}`} role="status">
      {state.key === 'needs' ? <span className="waiting-dot" aria-hidden="true" /> : <span className="spinner" aria-hidden="true" />}
      <span className="live-text">{state.sentence}</span>
      <span className="live-hint">
        <kbd className="key">Esc</kbd> to interrupt
      </span>
    </div>
  );
}

function Queue({ agent, run }: { agent: AgentRecord; run: (a: () => Promise<unknown>) => Promise<void> }) {
  return (
    <div className="queue" aria-label="Queued messages">
      <div className="queue-title mono">Queued · {agent.queue.length}</div>
      {agent.queue.map((m: QueuedMessage) => {
        const { source, text } = parsePrompt(m.text);
        const from = source.kind === 'user' ? 'You' : source.kind === 'orchestrator' ? source.name : source.kind === 'manager' ? 'Manager' : 'Claude Code';
        return (
          <div key={m.id} className="queue-item" title={text}>
            <span className="queue-source">{from}</span>
            <span className="queue-text">{text}</span>
            <button className="icon-button" aria-label="Remove from the queue" title="Remove from the queue" onClick={() => void run(() => commands.removeQueued(agent.id, m.id))}>
              <CloseIcon size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function readDraft(id: string): string {
  try {
    return sessionStorage.getItem(`agent-manager-draft:${id}`) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(id: string, text: string): void {
  try {
    if (text) sessionStorage.setItem(`agent-manager-draft:${id}`, text);
    else sessionStorage.removeItem(`agent-manager-draft:${id}`);
  } catch {
    // drafts are a convenience only
  }
}
