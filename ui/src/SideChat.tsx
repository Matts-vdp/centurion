import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { AgentRecord } from './api';
import { ChatIcon, CloseIcon, SendIcon } from './icons';
import { continueList, indentList } from './listInput';
import { sideChats, type SideEntry } from './sideChatStore';
import { money } from './status';
import { Markdown } from './Transcript';

/**
 * The side chat (/btw, Ctrl+;): questions about the agent's conversation, answered in a throw-away fork
 * of its session. The agent never sees them, nothing is saved, and closing the panel ends the fork.
 */
export function SideChat({ agent, focused }: { agent: AgentRecord; focused: boolean }) {
  const chat = sideChats.use(agent.id);
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const body = useRef<HTMLDivElement>(null);

  // A quoted selection (or opening the panel) fills and focuses the field.
  const fill = chat?.fill;
  useEffect(() => {
    if (!fill) return;
    if (fill.text) setText(fill.text);
    requestAnimationFrame(() => {
      const el = box.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [fill?.at]);

  // Follow the answer as it streams.
  useLayoutEffect(() => {
    const el = body.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat?.entries]);

  // Esc closes the panel while it has the focus.
  useEffect(() => {
    if (!chat || !focused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && body.current?.parentElement?.contains(document.activeElement)) {
        e.preventDefault();
        e.stopPropagation();
        sideChats.close(agent.id);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [!!chat, focused, agent.id]);

  if (!chat) return null;
  const send = () => {
    const value = text.trim();
    if (!value || chat.busy) return;
    void sideChats.ask(agent.id, value);
    setText('');
  };

  return (
    <aside className="side-chat" aria-label="Side question">
      <div className="side-chat-head">
        <span className="side-chat-title">Side question</span>
        {chat.costUsd > 0 && (
          <span className="side-chat-cost mono" title="What this side thread cost (added to the agent's total)">
            {money(chat.costUsd)}
          </span>
        )}
        <button className="icon-button" title="Close (Esc). Ends the side chat; nothing is saved" aria-label="Close the side question" onClick={() => sideChats.close(agent.id)}>
          <CloseIcon size={15} />
        </button>
      </div>
      <div className="side-chat-body" ref={body}>
        {chat.entries.length === 0 && (
          <p className="side-chat-empty">
            Ask about {agent.name}'s conversation without it entering the conversation. It answers in a copy of the session that can only read files, and
            nothing here is saved.
          </p>
        )}
        {chat.entries.map((e, i) => (
          <Entry key={i} entry={e} />
        ))}
        {chat.ended && !chat.busy && <p className="side-chat-ended">The side chat ended. The next question starts a new one, without these answers.</p>}
      </div>
      <div className="side-chat-compose">
        <textarea
          ref={box}
          rows={2}
          value={text}
          placeholder={chat.entries.length ? 'Ask a follow-up' : `Ask about ${agent.name}'s conversation`}
          aria-label="Side question"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.shiftKey && continueList(e)) || indentList(e)) return;
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="round-button send" aria-label="Ask" title="Ask (Enter)" disabled={!text.trim() || chat.busy} onClick={send}>
          <SendIcon size={15} />
        </button>
      </div>
    </aside>
  );
}

function Entry({ entry }: { entry: SideEntry }) {
  const answered = entry.parts.some((p) => p.kind === 'text' && p.text.trim());
  return (
    <div className="side-entry">
      <div className="side-question">
        <Markdown text={entry.question} />
      </div>
      {entry.parts.map((p, i) =>
        p.kind === 'text' ? (
          <div key={i} className="side-answer prose">
            <Markdown text={p.text} />
          </div>
        ) : (
          <div key={i} className="side-tool mono">
            {p.name} <span className="side-tool-detail">{p.detail}</span>
          </div>
        ),
      )}
      <div className={`side-foot${entry.error ? ' failed' : ''}`}>
        {!entry.done ? (
          <>
            <span className="spinner small" aria-hidden="true" />
            {answered ? 'Answering' : 'Thinking'}
          </>
        ) : entry.error ? (
          entry.error
        ) : (
          <span className="mono">{entry.costUsd !== null ? money(entry.costUsd) : ''}</span>
        )}
      </div>
    </div>
  );
}

/**
 * "Ask about this": a small button over a passage selected in the transcript. It opens the side chat with
 * the passage quoted in its field, for the question to follow.
 */
export function AskAboutSelection({ agentId, container }: { agentId: string; container: RefObject<HTMLElement | null> }) {
  const [at, setAt] = useState<{ x: number; y: number; text: string } | null>(null);

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const show = () => {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? '';
      if (!sel || sel.isCollapsed || !text || !el.contains(sel.anchorNode) || !el.contains(sel.focusNode)) return setAt(null);
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const box = el.getBoundingClientRect();
      // Above the selection's start, kept inside the transcript.
      setAt({ x: Math.min(Math.max(rect.left, box.left + 8), box.right - 140), y: Math.max(rect.top - 38, box.top + 6), text });
    };
    const later = () => setTimeout(show, 0);
    const hide = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setAt(null);
    };
    el.addEventListener('mouseup', later);
    el.addEventListener('keyup', later);
    const off = () => setAt(null);
    el.addEventListener('scroll', off, { passive: true });
    document.addEventListener('selectionchange', hide);
    return () => {
      el.removeEventListener('mouseup', later);
      el.removeEventListener('keyup', later);
      el.removeEventListener('scroll', off);
      document.removeEventListener('selectionchange', hide);
    };
  }, [container, agentId]);

  if (!at) return null;
  return (
    <button
      className="ask-selection"
      style={{ left: at.x, top: at.y }}
      // Keep the selection while clicking.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        sideChats.open(agentId, { quote: at.text });
        window.getSelection()?.removeAllRanges();
        setAt(null);
      }}
      title="Ask a side question about this passage (Ctrl+; opens the side chat)"
    >
      <ChatIcon size={13} />
      Ask about this
    </button>
  );
}
