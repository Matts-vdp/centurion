import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import type { AgentRecord } from './api';
import { CheckIcon, Chevron, ErrorIcon, LinkIcon } from './icons';
import { displayName, linkedExpert, summarize } from './tools';
import { pendingTool, type Item, type Source, type ToolItem, type Transcript as T } from './timeline';

type Props = {
  transcript: T;
  loading: boolean;
  loadError: string;
  agent: AgentRecord;
  agents: Map<string, AgentRecord>;
  onSelect: (id: string) => void;
};

export function Transcript({ transcript, loading, loadError, agent, agents, onSelect }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const running = agent.status === 'running';
  const now = useNow(running);

  // Keep the view pinned to the bottom while new items arrive, unless the user scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [transcript, loading, running]);

  const pending = running ? pendingTool(transcript) : null;

  return (
    <div
      className="transcript"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div className="transcript-inner">
        {loading && <div className="note">Loading history…</div>}
        {loadError && <div className="note error">Could not load the history: {loadError}</div>}
        {!loading && !loadError && transcript.items.length === 0 && !running && (
          <div className="note">No messages yet. Send this agent a message below.</div>
        )}
        {transcript.items.map((item) => (
          <ItemView key={item.key} item={item} agents={agents} onSelect={onSelect} now={now} running={running} />
        ))}
        {running && !loading && (
          <div className="activity-indicator">
            <span className="spinner" />
            {pending
              ? `Running ${displayName(pending.name)} for ${elapsed(now - pending.startedAt)}…`
              : 'Thinking…'}
          </div>
        )}
      </div>
    </div>
  );
}

/** Re-render every second while the agent runs, for elapsed times. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

type ItemProps = {
  item: Item;
  agents: Map<string, AgentRecord>;
  onSelect: (id: string) => void;
  now: number;
  running: boolean;
};

function ItemView({ item, agents, onSelect, now, running }: ItemProps) {
  switch (item.kind) {
    case 'prompt':
      return <Prompt text={item.text} source={item.source} />;
    case 'text':
      return (
        <div className="assistant-text">
          <Markdown text={item.text} />
        </div>
      );
    case 'note':
      return <div className={`note ${item.level}`}>{item.text}</div>;
    case 'tool':
      return <ToolCard tool={item} agents={agents} onSelect={onSelect} now={now} running={running} />;
  }
}

function sourceLabel(source: Source): string {
  if (source.kind === 'orchestrator') return `From orchestrator “${source.name}”`;
  if (source.kind === 'manager') return 'Manager notification';
  return 'You';
}

const Prompt = memo(function Prompt({ text, source }: { text: string; source: Source }) {
  return (
    <div className={`prompt from-${source.kind}`}>
      <div className="prompt-source">{sourceLabel(source)}</div>
      <div className="prompt-text">{text}</div>
    </div>
  );
});

const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeHighlight, { detect: false }]]}
      components={{
        a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
      }}
    >
      {text}
    </ReactMarkdown>
  );
});

const MAX_RESULT = 20_000;

function ToolCard({ tool, agents, onSelect, now, running }: { tool: ToolItem } & Omit<ItemProps, 'item'>) {
  const [open, setOpen] = useState(false);
  const name = displayName(tool.name);
  const summary = summarize(tool, agents);
  const expertId = linkedExpert(tool);
  const expert = expertId ? agents.get(expertId) : undefined;
  const done = tool.result !== undefined;
  const status = tool.denied ? 'denied' : tool.isError ? 'error' : done ? 'done' : running ? 'pending' : 'unfinished';

  return (
    <div className={`tool-card ${status}${open ? ' open' : ''}`}>
      <div className="tool-head" role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(!open)} onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setOpen(!open);
        }
      }}>
        <Chevron open={open} size={12} className="chevron" />
        <span className="tool-status">
          {status === 'pending' && <span className="spinner small" />}
          {status === 'done' && <CheckIcon size={13} />}
          {(status === 'error' || status === 'denied') && <ErrorIcon size={13} />}
        </span>
        <span className="tool-name">{name}</span>
        <span className="tool-summary">{summary}</span>
        {expert && (
          <button
            className="expert-link"
            title={`Open expert “${expert.name}”`}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(expert.id);
            }}
          >
            {expert.name}
            <LinkIcon size={12} />
          </button>
        )}
        <span className="tool-state">
          {status === 'pending' && elapsed(now - tool.startedAt)}
          {status === 'denied' && 'denied'}
          {status === 'error' && 'error'}
        </span>
      </div>
      {open && (
        <div className="tool-body">
          <div className="tool-section-label">Input</div>
          <ToolInput tool={tool} />
          {tool.denied && (
            <>
              <div className="tool-section-label">Denied</div>
              <pre className="tool-pre error">{tool.denied}</pre>
            </>
          )}
          {done && (
            <>
              <div className="tool-section-label">{tool.isError ? 'Error' : 'Result'}</div>
              <pre className={`tool-pre${tool.isError ? ' error' : ''}`}>
                {tool.result!.length > MAX_RESULT
                  ? `${tool.result!.slice(0, MAX_RESULT)}\n… (${tool.result!.length - MAX_RESULT} more characters)`
                  : tool.result || '(empty)'}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ToolInput({ tool }: { tool: ToolItem }) {
  const i = tool.input;
  const name = displayName(tool.name);
  if (name === 'Bash' && typeof i.command === 'string') {
    return (
      <>
        {typeof i.description === 'string' && <div className="tool-desc">{i.description}</div>}
        <pre className="tool-pre code">{i.command}</pre>
      </>
    );
  }
  if (name === 'Edit' && typeof i.old_string === 'string') {
    return (
      <>
        <div className="tool-desc">{String(i.file_path ?? '')}</div>
        <pre className="tool-pre diff">
          {String(i.old_string)
            .split('\n')
            .map((l, n) => (
              <span key={`o${n}`} className="del">{`- ${l}\n`}</span>
            ))}
          {String(i.new_string ?? '')
            .split('\n')
            .map((l, n) => (
              <span key={`n${n}`} className="add">{`+ ${l}\n`}</span>
            ))}
        </pre>
      </>
    );
  }
  if ((name === 'message_expert' || name === 'create_expert') && typeof i.message === 'string') {
    const { message, ...rest } = i;
    return (
      <>
        <pre className="tool-pre">{JSON.stringify(rest, null, 2)}</pre>
        <pre className="tool-pre">{message}</pre>
      </>
    );
  }
  return <pre className="tool-pre">{JSON.stringify(i, null, 2)}</pre>;
}
