import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import type { AgentRecord } from './api';
import { toBlocks, workDuration, workSummary, type RenderBlock, type Step } from './blocks';
import { useNow } from './hooks';
import {
  BellIcon,
  BotIcon,
  CheckIcon,
  Chevron,
  CopyIcon,
  EditIcon,
  ErrorIcon,
  FileIcon,
  GlobIcon,
  OpenIcon,
  SearchIcon,
  TerminalIcon,
  ThinkIcon,
  TodoIcon,
  ToolIcon,
  WebIcon,
  WriteIcon,
} from './icons';
import { DelegationView } from './Delegation';
import { AgentMark } from './Mark';
import { PlanView } from './Plan';
import { QuestionSetView } from './Questions';
import { clock, duration, money } from './status';
import { viewPrefs } from './store';
import { displayName, shortPath, summarize } from './tools';
import type { PromptItem, Transcript as T } from './timeline';

type Props = {
  transcript: T;
  loading: boolean;
  loadError: string;
  agent: AgentRecord;
  agents: Map<string, AgentRecord>;
  onSelect: (id: string) => void;
  run: (a: () => Promise<unknown>) => Promise<void>;
};

export function Transcript({ transcript, loading, loadError, agent, agents, onSelect, run }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const running = agent.status === 'running';
  const verbose = viewPrefs.use().verbose === true;
  const blocks = useMemo(() => toBlocks(transcript.items, agent.replies, running), [transcript, agent.replies, running]);

  // Ctrl+O toggles verbose mode: every work log open, with inputs and outputs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        viewPrefs.set('verbose', !(viewPrefs.get().verbose === true));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Keep the view pinned to the bottom while new items arrive, unless the user scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [blocks, loading]);

  // expertId → key of the latest delegation to it; only that one follows the expert live.
  const latest = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of blocks) if (b.kind === 'delegation' && b.expertId) m.set(b.expertId, b.key);
    return m;
  }, [blocks]);
  // Any expert this agent delegated to may be running: keep the clock going for their timers.
  const watching = [...latest.keys()].some((id) => agents.get(id)?.status === 'running');
  const now = useNow(running || watching);

  const ctx: Ctx = { agent, agents, onSelect, now, verbose, latest, run };

  return (
    <div
      className="transcript"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div className="transcript-column">
        {verbose && (
          <div className="verbose-note">
            Verbose: every step open.{' '}
            <button className="link-button" onClick={() => viewPrefs.set('verbose', false)}>
              Turn off
            </button>{' '}
            <kbd className="key">Ctrl O</kbd>
          </div>
        )}
        {loading && <div className="transcript-note">Loading history…</div>}
        {loadError && <div className="transcript-note error">Could not load the history: {loadError}</div>}
        {!loading && !loadError && blocks.length === 0 && !running && (
          <div className="transcript-note">No messages yet. Send {agent.name} a message below.</div>
        )}
        {blocks.map((b) => (
          <BlockView key={b.key} block={b} ctx={ctx} />
        ))}
      </div>
    </div>
  );
}

type Ctx = {
  agent: AgentRecord;
  agents: Map<string, AgentRecord>;
  onSelect: (id: string) => void;
  now: number;
  verbose: boolean;
  latest: Map<string, string>;
  run: (a: () => Promise<unknown>) => Promise<void>;
};

function BlockView({ block, ctx }: { block: RenderBlock; ctx: Ctx }) {
  switch (block.kind) {
    case 'message':
      return <Message item={block.item} ctx={ctx} />;
    case 'prose':
      return (
        <div className="prose">
          <Markdown text={block.text} />
        </div>
      );
    case 'work':
      return <WorkLog steps={block.steps} live={block.live} ctx={ctx} />;
    case 'event':
      return <EventLine block={block} ctx={ctx} />;
    case 'footer':
      return <TurnFooter block={block} />;
    case 'plan':
      return (
        <PlanView
          planId={block.planId}
          version={block.version}
          orchestrator={ctx.agent}
          agents={ctx.agents}
          now={ctx.now}
          onSelect={ctx.onSelect}
          run={ctx.run}
        />
      );
    case 'questions':
      return <QuestionSetView setId={block.setId} orchestrator={ctx.agent} agents={ctx.agents} now={ctx.now} onSelect={ctx.onSelect} run={ctx.run} />;
    case 'delegation':
      return (
        <DelegationView
          block={block}
          agents={ctx.agents}
          isLatest={block.expertId !== null && ctx.latest.get(block.expertId) === block.key}
          now={ctx.now}
          onSelect={ctx.onSelect}
        />
      );
  }
}

// ---------- messages into the agent ----------

const FOLD_LINES = 8;

function Message({ item, ctx }: { item: PromptItem; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = body.current;
    if (el && !open) setLong(el.scrollHeight > el.clientHeight + 2);
  }, [item.text, open]);

  const source = item.source;
  let speaker: ReactNode = 'You';
  if (source.kind === 'orchestrator') {
    const parent = ctx.agent.parentId ? ctx.agents.get(ctx.agent.parentId) : undefined;
    const sender =
      parent?.name === source.name ? parent : [...ctx.agents.values()].find((a) => a.kind === 'orchestrator' && a.name === source.name);
    speaker = (
      <>
        <AgentMark agent={sender ?? { name: source.name, kind: 'orchestrator' }} size={18} />
        {sender ? (
          <button className="speaker-link" onClick={() => ctx.onSelect(sender.id)}>
            {source.name}
          </button>
        ) : (
          source.name
        )}
        <span>asked</span>
      </>
    );
  } else if (source.kind === 'manager') {
    speaker = 'Manager';
  }

  return (
    <div className="message">
      <div className="speaker">
        {speaker}
        {item.at !== undefined && <span className="speaker-time">· {clock(item.at)}</span>}
      </div>
      <div className={`message-body${open ? ' open' : ''}`} ref={body} style={{ ['--fold-lines' as string]: FOLD_LINES }}>
        {item.text}
      </div>
      {(long || open) && (
        <button className="fold-toggle" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

// ---------- prose ----------

const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeHighlight, { detect: false }]]}
      components={{
        a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
        pre: ({ node: _node, children }) => <CodeBlock>{children}</CodeBlock>,
        table: ({ node: _node, ...props }) => (
          <div className="table-wrap">
            <table {...props} />
          </div>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
});

function CodeBlock({ children }: { children: ReactNode }) {
  const pre = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const [lang, setLang] = useState('');
  useLayoutEffect(() => {
    const cls = pre.current?.querySelector('code')?.className ?? '';
    setLang(/language-(\S+)/.exec(cls)?.[1] ?? '');
  }, [children]);
  const copy = () => {
    const text = pre.current?.innerText ?? '';
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="mono">{lang || 'text'}</span>
        <button className="icon-button" aria-label="Copy code" title="Copy" onClick={copy}>
          {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
        </button>
      </div>
      <pre ref={pre}>{children}</pre>
    </div>
  );
}

// ---------- work log ----------

function WorkLog({ steps, live, ctx }: { steps: Step[]; live: boolean; ctx: Ctx }) {
  const failed = steps.filter((s) => s.kind === 'tool' && (s.isError || s.denied)).length;
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? (ctx.verbose || failed > 0);
  const ms = workDuration(steps);
  const summary = workSummary(steps);
  const current = live ? steps.findLast((s) => s.kind === 'tool' && s.result === undefined && !s.denied) : undefined;
  const liveMs = live ? ctx.now - Math.min(...steps.map((s) => (s.kind === 'tool' ? s.startedAt : s.at))) : null;

  return (
    <div className={`work${isOpen ? ' open' : ''}`}>
      <button className="work-summary" aria-expanded={isOpen} onClick={() => setOpen(!isOpen)}>
        <Chevron open={isOpen} size={14} />
        {live ? (
          <span className="work-live">
            Working{liveMs !== null ? ` for ${duration(liveMs)}` : ''} · {summary}
          </span>
        ) : (
          <span>
            {ms !== null && ms >= 1000 ? `Worked for ${duration(ms)}` : 'Worked'} · {summary}
          </span>
        )}
        {failed > 0 && <span className="work-failed">· {failed} failed</span>}
      </button>
      {isOpen && (
        <ol className="steps">
          {steps.map((s) => (
            <StepRow key={s.key} step={s} ctx={ctx} running={s === current} />
          ))}
        </ol>
      )}
    </div>
  );
}

const MAX_OUTPUT = 20_000;

function StepRow({ step, ctx, running }: { step: Step; ctx: Ctx; running: boolean }) {
  const error = step.kind === 'tool' && (step.isError === true || step.denied !== undefined);
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? (ctx.verbose || error);
  const view = stepView(step, ctx.agents);
  const ms =
    step.kind === 'tool'
      ? running
        ? ctx.now - step.startedAt
        : step.endedAt !== undefined
          ? step.endedAt - step.startedAt
          : null
      : null;
  const unfinished = step.kind === 'tool' && step.result === undefined && !step.denied && !running;

  return (
    <li className={`step${error ? ' error' : ''}${running ? ' running' : ''}`}>
      <button className="step-head" aria-expanded={isOpen} onClick={() => setOpen(!isOpen)}>
        <span className="step-icon">{running ? <span className="spinner small" /> : error ? <ErrorIcon size={14} /> : view.icon}</span>
        <span className="step-label">
          {view.label}
          {view.detail && <span className="step-detail mono"> {view.detail}</span>}
        </span>
        {view.meta && <span className="step-meta mono">{view.meta}</span>}
        {unfinished && <span className="step-meta">no result</span>}
        {ms !== null && ms >= 1000 && <span className="step-time mono">{duration(ms)}</span>}
      </button>
      {isOpen && <StepBody step={step} />}
    </li>
  );
}

type StepView = { icon: ReactNode; label: ReactNode; detail?: string; meta?: string };

const fileName = (p: unknown) => (typeof p === 'string' ? (p.split(/[\\/]/).filter(Boolean).at(-1) ?? p) : '');
const lineCount = (s: unknown) => (typeof s === 'string' && s.length ? s.split('\n').length : 0);

function editCounts(i: Record<string, unknown>): { add: number; del: number } {
  const edits = Array.isArray(i.edits) ? (i.edits as Record<string, unknown>[]) : [i];
  return edits.reduce<{ add: number; del: number }>(
    (acc, e) => ({ add: acc.add + lineCount(e.new_string), del: acc.del + lineCount(e.old_string) }),
    { add: 0, del: 0 },
  );
}

function stepView(step: Step, agents: Map<string, AgentRecord>): StepView {
  if (step.kind === 'thinking') {
    const first = step.text.split('\n').find((l) => l.trim()) ?? '';
    return { icon: <ThinkIcon size={14} />, label: 'Thought', detail: first.length > 80 ? `${first.slice(0, 80)}…` : first };
  }
  const i = step.input;
  const name = displayName(step.name);
  const hasDescription = typeof i.description === 'string' && i.description.trim() !== '';
  switch (name) {
    case 'Bash':
      return {
        icon: <TerminalIcon size={14} />,
        label: hasDescription ? String(i.description) : 'Ran',
        detail: hasDescription ? undefined : firstLine(i.command, 80),
      };
    case 'Read':
      return { icon: <FileIcon size={14} />, label: 'Read', detail: fileName(i.file_path) };
    case 'Edit':
    case 'MultiEdit': {
      const { add, del } = editCounts(i);
      return { icon: <EditIcon size={14} />, label: 'Edited', detail: fileName(i.file_path), meta: `+${add} −${del}` };
    }
    case 'Write':
      return { icon: <WriteIcon size={14} />, label: 'Wrote', detail: fileName(i.file_path), meta: `${lineCount(i.content)} lines` };
    case 'Grep': {
      const hits = step.result !== undefined && !step.isError ? step.result.split('\n').filter((l) => l.trim()).length : null;
      return {
        icon: <SearchIcon size={14} />,
        label: 'Searched',
        detail: `"${firstLine(i.pattern, 60)}"${i.path ? ` in ${fileName(i.path)}` : ''}`,
        meta: hits !== null ? `${hits} hit${hits === 1 ? '' : 's'}` : undefined,
      };
    }
    case 'Glob':
      return { icon: <GlobIcon size={14} />, label: 'Found files', detail: firstLine(i.pattern, 60) };
    case 'WebFetch':
      return { icon: <WebIcon size={14} />, label: 'Fetched', detail: hostOf(i.url) };
    case 'WebSearch':
      return { icon: <WebIcon size={14} />, label: 'Searched the web for', detail: `"${firstLine(i.query, 60)}"` };
    case 'Task':
    case 'Agent':
      return { icon: <BotIcon size={14} />, label: 'Subagent', detail: firstLine(i.description, 80) };
    case 'TodoWrite':
      return { icon: <TodoIcon size={14} />, label: 'Updated the to-do list', meta: Array.isArray(i.todos) ? `${i.todos.length} items` : undefined };
    default:
      return { icon: <ToolIcon size={14} />, label: name, detail: summarize(step, agents) };
  }
}

function StepBody({ step }: { step: Step }) {
  if (step.kind === 'thinking') return <div className="step-body thinking">{step.text}</div>;
  const i = step.input;
  const name = displayName(step.name);
  const output = step.result !== undefined && <Output text={step.result} error={step.isError} />;
  const denied = step.denied && <div className="step-denied">Permission denied: {step.denied}</div>;
  if (name === 'Bash') {
    return (
      <div className="step-body">
        <pre className="code-plain">
          <span className="prompt-sign">$ </span>
          {String(i.command ?? '')}
        </pre>
        {denied}
        {output}
      </div>
    );
  }
  if (name === 'Edit' || name === 'MultiEdit' || name === 'Write') {
    const edits: Record<string, unknown>[] =
      name === 'Write' ? [{ old_string: '', new_string: i.content }] : Array.isArray(i.edits) ? (i.edits as Record<string, unknown>[]) : [i];
    return (
      <div className="step-body">
        <div className="diff-path mono" title={String(i.file_path ?? '')}>
          {shortPath(i.file_path)}
        </div>
        {edits.map((e, n) => (
          <Diff key={n} before={String(e.old_string ?? '')} after={String(e.new_string ?? '')} />
        ))}
        {denied}
        {step.isError && output}
      </div>
    );
  }
  if (name === 'Read') {
    return (
      <div className="step-body">
        <div className="diff-path mono" title={String(i.file_path ?? '')}>
          {shortPath(i.file_path)}
        </div>
        {denied}
        {output}
      </div>
    );
  }
  return (
    <div className="step-body">
      <pre className="code-plain">{JSON.stringify(i, null, 2)}</pre>
      {denied}
      {output}
    </div>
  );
}

function Output({ text: raw, error }: { text: string; error?: boolean }) {
  const text = raw.replace(/^\s*<tool_use_error>([\s\S]*)<\/tool_use_error>\s*$/, '$1');
  const shown = text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… (${(text.length - MAX_OUTPUT).toLocaleString()} more characters)` : text;
  return <pre className={`code-plain output${error ? ' error' : ''}`}>{shown || '(no output)'}</pre>;
}

const MAX_DIFF_LINES = 400;

function Diff({ before, after }: { before: string; after: string }) {
  const del = before ? before.split('\n') : [];
  const add = after ? after.split('\n') : [];
  const rows = [...del.map((l, n) => ['del', l, n + 1] as const), ...add.map((l, n) => ['add', l, n + 1] as const)];
  return (
    <div className="diff">
      {rows.slice(0, MAX_DIFF_LINES).map(([kind, text, num], n) => (
        <div key={n} className={`diff-line ${kind}`}>
          <span className="diff-num">{num}</span>
          <span className="diff-sign">{kind === 'del' ? '−' : '+'}</span>
          <span className="diff-text">{text || ' '}</span>
        </div>
      ))}
      {rows.length > MAX_DIFF_LINES && <div className="diff-more">… {rows.length - MAX_DIFF_LINES} more lines</div>}
    </div>
  );
}

// ---------- events and footers ----------

function EventLine({ block, ctx }: { block: Extract<RenderBlock, { kind: 'event' }>; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  const expert = block.notification ? ctx.agents.get(block.notification.expertId) : undefined;
  const preview = block.notification?.preview;
  return (
    <div className={`event ${block.level}`}>
      <div className="event-line">
        {block.level === 'error' ? <ErrorIcon size={14} /> : <BellIcon size={14} />}
        <span className="event-text">{block.text}</span>
        {block.at !== undefined && <span className="event-time mono">{clock(block.at)}</span>}
        {preview && (
          <button className="event-button" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Hide preview' : 'Preview'}
          </button>
        )}
        {expert && (
          <button className="event-button" onClick={() => ctx.onSelect(expert.id)}>
            Open <OpenIcon size={13} />
          </button>
        )}
      </div>
      {open && preview && <div className="event-preview">{preview}</div>}
    </div>
  );
}

function TurnFooter({ block }: { block: Extract<RenderBlock, { kind: 'footer' }> }) {
  const { reply, tools, durationMs } = block;
  const time = durationMs !== undefined && durationMs > 0 ? duration(durationMs) : null;
  const parts: string[] = [];
  if (reply.interrupted) parts.push(`Interrupted by you${time ? ` after ${time}` : ''}`);
  else if (reply.isError) parts.push(`Failed${time ? ` after ${time}` : ''}`);
  else parts.push(time ? `Done in ${time}` : 'Done');
  if (tools) parts.push(`${tools} tool${tools === 1 ? '' : 's'}`);
  if (reply.costUsd !== undefined) parts.push(money(reply.costUsd));
  return (
    <div className={`turn-footer mono${reply.isError ? ' error' : ''}`}>
      <span>{parts.join(' · ')}</span>
      {reply.isError && <span className="turn-error">{reply.text}</span>}
    </div>
  );
}

function firstLine(v: unknown, max: number): string {
  const s = typeof v === 'string' ? v : '';
  const line = s.split('\n').find((l) => l.trim()) ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function hostOf(u: unknown): string {
  try {
    return new URL(String(u)).host;
  } catch {
    return firstLine(u, 60);
  }
}
