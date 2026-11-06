import { useCallback, useEffect, useRef, useState } from 'react';
import { commands, type AgentRecord, type QueuedMessage } from './api';
import { Header } from './Header';
import { CloseIcon, SendIcon, StopIcon } from './icons';
import { lastSeen, store, type LiveEvent } from './store';
import { Transcript } from './Transcript';
import { addNote, applyLive, emptyTranscript, fromHistory, parsePrompt, type Transcript as T } from './timeline';

type Props = {
  agent: AgentRecord;
  agents: Map<string, AgentRecord>;
  epoch: number;
  onSelect: (id: string) => void;
  onOpenDrawer?: () => void;
};

export function AgentView({ agent, agents, epoch, onSelect, onOpenDrawer }: Props) {
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

  // Alt+← goes to the parent orchestrator.
  useEffect(() => {
    if (!parent) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.key === 'ArrowLeft' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        onSelect(parent.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [parent, onSelect]);

  return (
    <div className="agent-view">
      <Header agent={agent} parent={parent} agents={agents} run={run} onSelect={onSelect} onOpenDrawer={onOpenDrawer} />
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
