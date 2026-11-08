import { useCallback, useEffect, useRef, useState } from 'react';
import { commands, type AgentRecord } from './api';
import { Composer } from './Composer';
import { FilesPanel } from './Files';
import { fileLinks, panels, usePanel, type OpenRequest } from './fileStore';
import { Header } from './Header';
import { useWindowActive } from './hooks';
import { CloseIcon } from './icons';
import { lastSeen, store, type LiveEvent } from './store';
import { Transcript } from './Transcript';
import { applyLive, emptyTranscript, fromHistory, parsePrompt, type Transcript as T } from './timeline';

type Props = {
  agent: AgentRecord;
  agents: Map<string, AgentRecord>;
  epoch: number;
  /** Which pane of the main area this is (0 = left); the Files panel's state is per pane. */
  pane: number;
  /** The focused pane: keyboard shortcuts act here only. */
  focused: boolean;
  onSelect: (id: string) => void;
  /** Close this pane of a split. */
  onClose?: () => void;
  onOpenDrawer?: () => void;
};

export function AgentView({ agent, agents, epoch, pane, focused, onSelect, onClose, onOpenDrawer }: Props) {
  // A rewind switches the agent to another session: load its history again.
  const [generation, setGeneration] = useState(0);
  const sessionRef = useRef(agent.sessionId);
  useEffect(() => {
    if (sessionRef.current && sessionRef.current !== agent.sessionId) setGeneration((g) => g + 1);
    sessionRef.current = agent.sessionId;
  }, [agent.sessionId]);
  const { transcript, loading, loadError } = useTranscript(agent, `${epoch}:${generation}`);
  const [error, setError] = useState('');
  const parent = agent.parentId ? agents.get(agent.parentId) : undefined;

  // Opening an agent, or watching it finish a turn, counts as seen, but only while the window is
  // in view: a reply that lands while you are elsewhere stays unread (and counts in the tab title).
  const active = useWindowActive();
  useEffect(() => {
    if (active) lastSeen.set(agent.id, agent.lastActivityAt);
  }, [agent.id, agent.lastActivityAt, active]);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setError('');
    try {
      const result = await action();
      if (result && typeof result === 'object' && 'kind' in result) store.upsert(result as AgentRecord);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Files: the panel's open state is per pane; transcript links open it at a file.
  const files = usePanel(pane);
  const [fileRequest, setFileRequest] = useState<OpenRequest | null>(null);
  useEffect(
    () =>
      fileLinks.on((r) => {
        if (r.agentId !== agent.id) return;
        panels.set(pane, { open: true });
        setFileRequest(r);
      }),
    [agent.id, pane],
  );
  const doneRequest = useCallback(() => setFileRequest(null), []);

  // Ctrl+B opens and closes the Files panel of the focused pane.
  useEffect(() => {
    if (!focused) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        panels.toggle(pane);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused, pane]);

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
      <Header
        agent={agent}
        parent={parent}
        agents={agents}
        run={run}
        onSelect={onSelect}
        onClose={onClose}
        onOpenDrawer={onOpenDrawer}
        filesOpen={files.open}
        onToggleFiles={() => panels.toggle(pane)}
      />
      {error && (
        <div className="banner error">
          {error}
          <button className="icon-button" title="Dismiss" onClick={() => setError('')}>
            <CloseIcon size={14} />
          </button>
        </div>
      )}
      <div className="agent-main">
      <div className="agent-body">
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
      {files.open && <FilesPanel key={agent.id} agent={agent} pane={pane} request={fileRequest} onRequestDone={doneRequest} />}
      </div>
    </div>
  );
}



// ---------- transcript loading ----------

/**
 * History from /history, then live events for this agent. Live events that arrive while the history
 * loads are buffered and applied afterwards (duplicates are dropped by uuid). Reloads on reconnect.
 */
function useTranscript(agent: AgentRecord, reloadKey: string) {
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
  }, [agent.id, reloadKey]);

  return { transcript, loading, loadError };
}
