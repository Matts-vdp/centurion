import { useCallback, useEffect, useRef, useState } from 'react';
import { commands, type AgentRecord, type QueuedMessage } from './api';
import { BackIcon, CloseIcon, MoreIcon, SendIcon, StopIcon } from './icons';
import { STATUS_LABEL, StatusDot } from './StatusDot';
import { lastSeen, store, type LiveEvent } from './store';
import { Transcript } from './Transcript';
import { addNote, applyLive, emptyTranscript, fromHistory, parsePrompt, type Transcript as T } from './timeline';

type Props = {
  agent: AgentRecord;
  agents: Map<string, AgentRecord>;
  epoch: number;
  onSelect: (id: string) => void;
};

export function AgentView({ agent, agents, epoch, onSelect }: Props) {
  const { transcript, loading, loadError } = useTranscript(agent, epoch);
  const [error, setError] = useState('');
  const parent = agent.parentId ? agents.get(agent.parentId) : undefined;

  // Opening an agent, or watching it finish a turn, counts as seen.
  useEffect(() => {
    lastSeen.set(agent.id, agent.lastActivityAt);
  }, [agent.id, agent.lastActivityAt]);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setError('');
    try {
      const result = await action();
      if (result && typeof result === 'object' && 'kind' in result) store.upsert(result as AgentRecord);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const interrupt = useCallback(() => run(() => commands.interrupt(agent.id)), [run, agent.id]);

  return (
    <div className="agent-view">
      <div className="breadcrumb-bar">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          {parent && (
            <>
              <button className="crumb" onClick={() => onSelect(parent.id)}>
                {parent.name}
              </button>
              <span className="crumb-sep">▸</span>
            </>
          )}
          <span className="crumb current">{agent.name}</span>
        </nav>
        {parent && (
          <button className="button secondary small" onClick={() => onSelect(parent.id)}>
            <BackIcon size={14} /> Back to orchestrator
          </button>
        )}
      </div>
      <Header agent={agent} run={run} />
      {error && (
        <div className="banner error">
          {error}
          <button className="icon-button" title="Dismiss" onClick={() => setError('')}>
            <CloseIcon size={14} />
          </button>
        </div>
      )}
      <Transcript
        transcript={transcript}
        loading={loading}
        loadError={loadError}
        agent={agent}
        agents={agents}
        onSelect={onSelect}
      />
      <Composer agent={agent} run={run} onInterrupt={interrupt} />
    </div>
  );
}

// ---------- header ----------

function Header({ agent, run }: { agent: AgentRecord; run: (a: () => Promise<unknown>) => Promise<void> }) {
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const busy = agent.status === 'running' || agent.queue.length > 0;

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

  const ctx = agent.context;
  const ctxPct = ctx && ctx.windowTokens ? Math.round((ctx.usedTokens / ctx.windowTokens) * 100) : null;

  return (
    <header className="agent-header">
      <div className="agent-title">
        <StatusDot status={agent.status} />
        <h2>{agent.name}</h2>
        <span className="pill">{agent.kind}</span>
        {agent.archived && <span className="pill">archived</span>}
      </div>
      <div className="agent-meta">
        <span className={`meta-status ${agent.status}`}>{STATUS_LABEL[agent.status]}</span>
        <span className="meta-folder" title={agent.cwd}>
          {/* rtl container + bdi keeps the path readable but puts the ellipsis at the start */}
          <bdi>{agent.cwd}</bdi>
        </span>
        <span title="Total cost of this agent">${agent.costUsd.toFixed(agent.costUsd < 1 ? 3 : 2)}</span>
        <span
          className={`meta-context${ctxPct !== null && ctxPct >= 80 ? ' warn' : ''}`}
          title={ctx ? `${ctx.usedTokens.toLocaleString()} of ${ctx.windowTokens.toLocaleString()} tokens after the last turn` : 'Known after the first turn'}
        >
          ctx {ctxPct === null ? '–' : `${ctxPct}%`}
        </span>
      </div>
      <div className="agent-actions" ref={menuRef}>
        <button className="icon-button" title="More actions" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
          <MoreIcon />
        </button>
        {menu && (
          <div className="menu" role="menu">
            {agent.kind === 'expert' && (
              <button
                role="menuitem"
                disabled={!agent.archived && busy}
                title={!agent.archived && busy ? 'Only an idle or stopped agent can be archived' : undefined}
                onClick={() => {
                  setMenu(false);
                  void run(() => commands.setArchived(agent.id, !agent.archived));
                }}
              >
                {agent.archived ? 'Unarchive' : 'Archive'}
              </button>
            )}
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
    </header>
  );
}

// ---------- composer ----------

function Composer({
  agent,
  run,
  onInterrupt,
}: {
  agent: AgentRecord;
  run: (a: () => Promise<unknown>) => Promise<void>;
  onInterrupt: () => void;
}) {
  const [text, setText] = useState(() => readDraft(agent.id));
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const running = agent.status === 'running';

  useEffect(() => writeDraft(agent.id, text), [agent.id, text]);
  useEffect(() => box.current?.focus(), [agent.id]);

  // Esc interrupts the running turn (the queue stays), unless something else handles it.
  useEffect(() => {
    if (!running) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if ((e.target as HTMLElement | null)?.closest('.sidebar, .menu')) return;
      e.preventDefault();
      onInterrupt();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running, onInterrupt]);

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
    <div className="composer">
      {agent.queue.length > 0 && <Queue agent={agent} run={run} />}
      <div className="composer-box">
        <textarea
          ref={box}
          rows={1}
          value={text}
          placeholder={
            running
              ? `Queue a message for ${agent.name} (Esc interrupts the current turn)`
              : `Message ${agent.name} (Enter to send, Shift+Enter for a new line)`
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-buttons">
          {running && (
            <button className="button secondary" title="Interrupt the current turn (Esc). The queue stays." onClick={onInterrupt}>
              <StopIcon size={14} /> Stop
            </button>
          )}
          <button className="button primary" disabled={!text.trim() || sending} onClick={() => void send()} title={running ? 'Queue' : 'Send'}>
            <SendIcon size={14} /> {running ? 'Queue' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Queue({ agent, run }: { agent: AgentRecord; run: (a: () => Promise<unknown>) => Promise<void> }) {
  return (
    <div className="queue" aria-label="Queued messages">
      <div className="queue-title">Queued ({agent.queue.length})</div>
      {agent.queue.map((m: QueuedMessage) => {
        const { source, text } = parsePrompt(m.text);
        const from = source.kind === 'user' ? 'You' : source.kind === 'manager' ? 'Manager' : 'Orchestrator';
        return (
          <div key={m.id} className="queue-item" title={text}>
            <span className="queue-source">{from}</span>
            <span className="queue-text">{text}</span>
            <button className="icon-button" title="Remove from the queue" onClick={() => void run(() => commands.removeQueued(agent.id, m.id))}>
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

// ---------- transcript loading ----------

/**
 * History from /history, then live events for this agent. Live events that arrive while the history
 * loads are buffered and applied afterwards (duplicates are dropped by uuid). Reloads on reconnect.
 */
function useTranscript(agent: AgentRecord, epoch: number) {
  const [transcript, setTranscript] = useState<T>(emptyTranscript);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const lastReplyAt = useRef<string | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let buffer: LiveEvent[] | null = [];
    loaded.current = false;
    setLoading(true);
    setLoadError('');
    const off = store.onLive((e) => {
      if (e.agentId !== agent.id) return;
      if (buffer) buffer.push(e);
      else setTranscript((t) => applyLive(t, e));
    });
    commands
      .history(agent.id)
      .then((messages) => {
        if (cancelled) return;
        let t = fromHistory(messages);
        // The prompt of the running turn may not be in the session file yet.
        const current = agentRef.current.current;
        if (current) {
          const lastPrompt = [...t.items].reverse().find((i) => i.kind === 'prompt');
          if (!lastPrompt || lastPrompt.kind !== 'prompt' || lastPrompt.text !== parsePrompt(current.text).text) {
            t = applyLive(t, { kind: 'delivered', message: current });
          }
        }
        for (const e of buffer ?? []) t = applyLive(t, e);
        buffer = null;
        setTranscript(t);
      })
      .catch((err) => {
        if (cancelled) return;
        buffer = null;
        setLoadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (cancelled) return;
        lastReplyAt.current = agentRef.current.replies.at(-1)?.at ?? null;
        loaded.current = true;
        setLoading(false);
      });
    return () => {
      cancelled = true;
      off();
    };
  }, [agent.id, epoch]);

  // Turn-end notes come from the record: interrupts are not errors, failures are highlighted.
  const lastReply = agent.replies.at(-1);
  useEffect(() => {
    if (!loaded.current || !lastReply || lastReply.at === lastReplyAt.current) return;
    lastReplyAt.current = lastReply.at;
    if (lastReply.interrupted) setTranscript((t) => addNote(t, 'Interrupted', 'info'));
    else if (lastReply.isError) setTranscript((t) => addNote(t, lastReply.text, 'error'));
  }, [lastReply]);

  return { transcript, loading, loadError };
}
