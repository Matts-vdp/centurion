import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { commands, type AgentRecord, type QueuedMessage } from './api';
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
          {agent.queue.length > 0 && <Queue agent={agent} run={run} />}
          <div className="composer-body">
            <textarea
              ref={box}
              rows={2}
              value={text}
              aria-label={running ? `Queue a message for ${agent.name}` : `Message ${agent.name}`}
              placeholder={running ? `Queue a message for ${agent.name}` : (decision?.placeholder ?? `Message ${agent.name}`)}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
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
