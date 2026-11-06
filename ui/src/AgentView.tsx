import { useCallback, useEffect, useRef, useState } from 'react';
import { commands, type AgentRecord } from './api';
import { Composer } from './Composer';
import { Header } from './Header';
import { CloseIcon } from './icons';
import { lastSeen, store, type LiveEvent } from './store';
import { Transcript } from './Transcript';
import { applyLive, emptyTranscript, fromHistory, parsePrompt, type Transcript as T } from './timeline';

type Props = {
  agent: AgentRecord;
  agents: Map<string, AgentRecord>;
  epoch: number;
  /** The focused pane: keyboard shortcuts act here only. */
  focused: boolean;
  onSelect: (id: string) => void;
  /** Close this pane of a split. */
  onClose?: () => void;
  onOpenDrawer?: () => void;
};

export function AgentView({ agent, agents, epoch, focused, onSelect, onClose, onOpenDrawer }: Props) {
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
    if (!parent || !focused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.key === 'ArrowLeft' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        onSelect(parent.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [parent, focused, onSelect]);

  return (
    <div className="agent-view">
      <Header agent={agent} parent={parent} agents={agents} run={run} onSelect={onSelect} onClose={onClose} onOpenDrawer={onOpenDrawer} />
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
        focused={focused}
        onSelect={onSelect}
        run={run}
      />
      <Composer agent={agent} agents={agents} focused={focused} run={run} onInterrupt={interrupt} />
    </div>
  );
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

  useEffect(() => {
    let cancelled = false;
    let buffer: LiveEvent[] | null = [];
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
        setLoading(false);
      });
    return () => {
      cancelled = true;
      off();
    };
  }, [agent.id, epoch]);

  return { transcript, loading, loadError };
}
