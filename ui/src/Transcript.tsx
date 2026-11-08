import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Element as HastElement } from 'hast';
import ReactMarkdown from 'react-markdown';
import { fileLinks } from './fileStore';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { commands, type AgentRecord, type PermissionDecision, type PermissionRequest } from './api';
import { toBlocks, workDuration, workSummary, type RenderBlock, type Step } from './blocks';
import { useNow } from './hooks';
import {
  ArrowDownIcon,
  BellIcon,
  BotIcon,
  CheckIcon,
  Chevron,
  CopyIcon,
  EditIcon,
  ErrorIcon,
  FileIcon,
  ForkIcon,
  GlobIcon,
  OpenIcon,
  RewindIcon,
  SearchIcon,
  TerminalIcon,
  ThinkIcon,
  TodoIcon,
  ToolIcon,
  VisualIcon,
  WebIcon,
  WriteIcon,
} from './icons';
import { DelegationView } from './Delegation';
import { AgentMark } from './Mark';
import { MermaidBlock } from './Mermaid';
import { PlanView } from './Plan';
import { QuestionSetView } from './Questions';
import { VisualView } from './Visual';
import { clock, duration, money } from './status';
import { composerFill, pendingPermissions, permissionFor, store, transcriptPin, useManager, viewPrefs } from './store';
import { displayName, shortPath, summarize } from './tools';
import { fromSubagent, type Item, type PromptItem, type Sub, type ToolItem, type Transcript as T } from './timeline';
import { continueList } from './listInput';

type Props = {
  transcript: T;
  loading: boolean;
  loadError: string;
  agent: AgentRecord;
  agents: Map<string, AgentRecord>;
  /** Only the focused pane handles Ctrl+O, so two panes don't toggle it twice. */
  focused: boolean;
  onSelect: (id: string) => void;
  run: (a: () => Promise<unknown>) => Promise<void>;
};

export function Transcript({ transcript, loading, loadError, agent, agents, focused, onSelect, run }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const running = agent.status === 'running';
  const verbose = viewPrefs.use().verbose === true;
  const blocks = useMemo(() => toBlocks(transcript.items, agent.replies, running), [transcript, agent.replies, running]);

  // Ctrl+O toggles verbose mode: every work log open, with inputs and outputs.
  useEffect(() => {
    if (!focused) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        viewPrefs.set('verbose', !(viewPrefs.get().verbose === true));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused]);

  // Keep the view pinned to the bottom while new items arrive, unless the user scrolled up.
  // Scrolled up, new blocks below show the jump-to-latest button.
  const column = useRef<HTMLDivElement>(null);
  const [behind, setBehind] = useState(false);
  const seenCount = useRef(0);
  const runningRef = useRef(running);
  runningRef.current = running;
  const { permissions } = useManager();
  const asks = pendingPermissions(agent.id, { permissions });
  const count = blocks.length + asks.length;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
    else if (!loading && count > seenCount.current) setBehind(true);
    seenCount.current = count;
  }, [blocks, loading, count]);

  // Content also grows in place (streamed prose, diagrams, images, subagent steps): follow it too.
  useEffect(() => {
    const el = column.current;
    if (!el) return;
    let height = el.offsetHeight;
    const observer = new ResizeObserver(() => {
      const grew = el.offsetHeight > height;
      height = el.offsetHeight;
      const s = scroller.current;
      if (!s || !grew) return;
      if (stick.current) s.scrollTop = s.scrollHeight;
      else if (runningRef.current) setBehind(true);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Instant, not smooth: a smooth scroll would race the content still arriving.
  const jump = () => {
    const el = scroller.current;
    stick.current = true;
    setBehind(false);
    if (el) el.scrollTop = el.scrollHeight;
  };
  // Sending a message brings the view back to the bottom.
  useEffect(() => {
    const off = transcriptPin.subscribe(() => {
      const pin = transcriptPin.get();
      if (pin?.agentId === agent.id) jump();
    });
    return () => {
      off();
    };
  }, [agent.id]);

  // expertId → key of the latest delegation to it; only that one follows the expert live.
  const latest = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of blocks) if (b.kind === 'delegation' && b.expertId) m.set(b.expertId, b.key);
    return m;
  }, [blocks]);
  // Any expert this agent delegated to may be running: keep the clock going for their timers.
  const watching = [...latest.keys()].some((id) => agents.get(id)?.status === 'running');
  const now = useNow(running || watching);

  const ctx: Ctx = { agent, agents, onSelect, now, verbose, latest, run, subs: transcript.subs, asks: asks.length };
  // message key → how many messages come after it (the turns a rewind there drops besides its own).
  const messagesAfter = useMemo(() => {
    const keys = blocks.filter((b) => b.kind === 'message').map((b) => b.key);
    return new Map(keys.map((k, i) => [k, keys.length - 1 - i]));
  }, [blocks]);

  return (
    <div className="transcript-wrap">
    <div
      className="transcript"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        if (stick.current) setBehind(false);
      }}
    >
      <div className="transcript-column" ref={column}>
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
          <BlockView key={b.key} block={b} ctx={ctx} after={b.kind === 'message' ? messagesAfter.get(b.key) : undefined} />
        ))}
        {asks.map((p, i) => (
          <PermissionView key={p.id} request={p} ctx={ctx} autoFocus={focused && i === 0} />
        ))}
      </div>
    </div>
      {behind && (
        <button className="jump-latest" onClick={jump} title="Scroll to the newest activity and follow it">
          <ArrowDownIcon size={14} />
          New activity
        </button>
      )}
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
  subs: Map<string, Sub>;
  /** Pending permission requests: no rewind while one waits. */
  asks: number;
};

function BlockView({ block, ctx, after }: { block: RenderBlock; ctx: Ctx; after?: number }) {
  switch (block.kind) {
    case 'message':
      return <Message item={block.item} ctx={ctx} after={after ?? 0} />;
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
    case 'subagent':
      return <SubagentView block={block} ctx={ctx} />;
    case 'visual':
      return <VisualView title={block.title} markup={block.markup} agent={ctx.agent} agents={ctx.agents} onSelect={ctx.onSelect} />;
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

function Message({ item, ctx, after }: { item: PromptItem; ctx: Ctx; after: number }) {
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const agent = ctx.agent;
  const running = agent.status === 'running';
  // The turn this message started is still running: it can't be forked or rewound yet.
  const ownTurnRunning = running && after === 0;
  const rewindBlocker = running
    ? 'Rewind when the agent is idle'
    : agent.queue.length > 0
      ? 'Rewind when nothing is queued'
      : ctx.asks > 0
        ? 'Answer the permission request first'
        : null;

  const fork = async () => {
    if (!item.uuid || busy) return;
    setBusy(true);
    await ctx.run(async () => {
      const rec = await commands.fork(agent.id, item.uuid!);
      store.upsert(rec);
      ctx.onSelect(rec.id);
    });
    setBusy(false);
  };

  const rewind = async () => {
    if (!item.uuid || busy) return;
    setBusy(true);
    await ctx.run(async () => {
      const rec = await commands.rewind(agent.id, item.uuid!);
      store.upsert(rec);
      if (item.source.kind === 'user') composerFill.set({ agentId: agent.id, text: item.text });
    });
    setBusy(false);
    setConfirming(false);
  };
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

  const canAct = item.uuid !== undefined && !ownTurnRunning;
  return (
    <div className={`message${confirming ? ' confirming' : ''}`}>
      <div className="speaker">
        {speaker}
        {item.at !== undefined && <span className="speaker-time">· {clock(item.at)}</span>}
        {canAct && !confirming && (
          <span className="message-tools">
            <button className="icon-button small" disabled={busy} aria-label="Fork from here" title="Fork from here: a new agent with the conversation up to the end of this turn" onClick={() => void fork()}>
              <ForkIcon size={14} />
            </button>
            <button
              className="icon-button small"
              disabled={busy || rewindBlocker !== null}
              aria-label="Rewind to before this message"
              title={rewindBlocker ?? 'Rewind: drop this turn and everything after it. Files are not changed.'}
              onClick={() => setConfirming(true)}
            >
              <RewindIcon size={14} />
            </button>
          </span>
        )}
      </div>
      {confirming && (
        <div className="rewind-confirm" role="group" aria-label="Rewind">
          <span>
            Drop this turn{after > 0 ? ` and the ${after} after it` : ''}? {item.source.kind === 'user' ? 'The message goes back into the composer. ' : ''}Files are not changed.
          </span>
          <button className="button secondary small" disabled={busy} onClick={() => setConfirming(false)}>
            Cancel
          </button>
          <button className="button primary small" disabled={busy || rewindBlocker !== null} title={rewindBlocker ?? undefined} autoFocus onClick={() => void rewind()}>
            Rewind
          </button>
        </div>
      )}
      {item.images && <ImageStrip images={item.images} />}
      {item.text && (
        <div className={`message-body${open ? ' open' : ''}`} ref={body} style={{ ['--fold-lines' as string]: FOLD_LINES }}>
          {item.text}
        </div>
      )}
      {(long || open) && (
        <button className="fold-toggle" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

/** Thumbnails of the images sent with a message; a click shows one full size. */
function ImageStrip({ images }: { images: string[] }) {
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setShown(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [shown]);
  return (
    <div className="message-images">
      {images.map((src, n) => (
        <button key={n} className="message-image" aria-label={`Show image ${n + 1}`} onClick={() => setShown(src)}>
          <img src={src} alt={`Image ${n + 1}`} />
        </button>
      ))}
      {shown && (
        <div className="lightbox" role="dialog" aria-label="Image" onClick={() => setShown(null)}>
          <img src={shown} alt="" />
        </div>
      )}
    </div>
  );
}

// ---------- prose ----------

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeHighlight, { detect: false }]]}
      components={{
        a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
        pre: ({ node, children }) => {
          const mermaid = mermaidSource(node);
          return mermaid !== null ? (
            <MermaidBlock code={mermaid} fallback={<CodeBlock>{children}</CodeBlock>} />
          ) : (
            <CodeBlock>{children}</CodeBlock>
          );
        },
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

/** The source of a ```mermaid block, from the `pre` element's `code` child; null for any other block. */
function mermaidSource(pre: HastElement | undefined): string | null {
  const code = pre?.children[0];
  if (!code || code.type !== 'element' || code.tagName !== 'code') return null;
  const cls = code.properties.className;
  if (!Array.isArray(cls) || !cls.includes('language-mermaid')) return null;
  const text = (n: HastElement['children'][number]): string =>
    n.type === 'text' ? n.value : n.type === 'element' ? n.children.map(text).join('') : '';
  return code.children.map(text).join('');
}

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

// ---------- subagents ----------

/** What the Agent tool's result says besides the reply: its usage, and whether it went to the background. */
function subagentResult(text: string) {
  const usage = /<usage>([\s\S]*?)<\/usage>/.exec(text)?.[1] ?? '';
  const num = (key: string) => {
    const m = new RegExp(`${key}:\\s*(\\d+)`).exec(usage);
    return m ? Number(m[1]) : undefined;
  };
  const reply = text
    .replace(/<usage>[\s\S]*?<\/usage>/g, '')
    .replace(/^agentId: .*$/gm, '')
    .trim();
  return { reply, background: /^Async agent launched/.test(text), toolUses: num('tool_uses'), durationMs: num('duration_ms') };
}

/**
 * A subagent: one line in the turn, with what it is doing (the latest progress summary) or how it ended.
 * Opening it shows its prompt, its steps (live, or from its own transcript) and its reply.
 */
function SubagentView({ block, ctx }: { block: Extract<RenderBlock, { kind: 'subagent' }>; ctx: Ctx }) {
  const { tool, live } = block;
  const sub = ctx.subs.get(tool.id);
  const ended = sub?.ended ?? (block.ended?.status as Sub['ended'] | undefined);
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? ctx.verbose;
  const [loaded, setLoaded] = useState<Item[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const running = live && tool.result === undefined && !tool.denied;
  const result = tool.result !== undefined && !tool.isError ? subagentResult(tool.result) : null;
  const background = result?.background === true && !ended;
  const failed = tool.isError === true || tool.denied !== undefined || ended === 'failed';
  const liveItems = sub?.items.length ? sub.items : null;
  const items = liveItems ?? loaded ?? [];
  // SubagentHandback is how a background subagent delivers its report; the report shows as the reply.
  const steps = items.filter((it): it is Step => it.kind === 'thinking' || (it.kind === 'tool' && it.name !== 'SubagentHandback'));
  const current = running ? steps.findLast((s) => s.kind === 'tool' && s.result === undefined && !s.denied) : undefined;
  const i = tool.input;
  const kind = typeof i.subagent_type === 'string' && i.subagent_type && i.subagent_type !== 'general-purpose' ? i.subagent_type : 'Subagent';
  const description = firstLine(i.description, 100) || firstLine(i.prompt, 100);

  // The steps of a finished subagent come from its own transcript, once it is opened.
  useEffect(() => {
    if (!isOpen || liveItems || loaded || running || tool.result === undefined) return;
    let cancelled = false;
    commands
      .subagent(ctx.agent.id, tool.id)
      .then((messages) => {
        if (!cancelled) setLoaded(fromSubagent(messages));
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, liveItems, loaded, running, tool.result, tool.id, ctx.agent.id]);

  const tools = sub?.toolUses ?? result?.toolUses ?? (items.length ? steps.filter((s) => s.kind === 'tool').length : undefined);
  const toolCount = tools !== undefined && tools > 0 ? `${tools} tool${tools === 1 ? '' : 's'}` : null;
  let status: string;
  if (running) {
    const doing = sub?.summary ?? (current?.kind === 'tool' ? `Running ${displayName(current.name)}` : 'Working');
    status = [doing, toolCount, duration(ctx.now - tool.startedAt)].filter(Boolean).join(' · ');
  } else if (failed) {
    // A background subagent that failed later says why in its notification, not in the tool result.
    const why =
      tool.isError || tool.denied
        ? (tool.denied ?? tool.result ?? '').replace(/<\/?tool_use_error>/g, '').trim().split('\n')[0]
        : (block.ended?.summary ?? '');
    status = why ? `Failed · ${why}` : 'Failed';
  } else if (background) {
    status = sub?.summary ? `In the background · ${sub.summary}` : 'Running in the background';
  } else if (ended === 'stopped') {
    status = 'Stopped';
  } else if (tool.result === undefined) {
    status = 'No result';
  } else {
    const ms = sub?.durationMs ?? result?.durationMs ?? (tool.endedAt !== undefined ? tool.endedAt - tool.startedAt : undefined);
    status = [ms !== undefined && ms >= 1000 ? `Done in ${duration(ms)}` : 'Done', toolCount].filter(Boolean).join(' · ');
  }
  const reply = result && !result.background ? result.reply : (block.report ?? '');

  return (
    <div className={`subagent${isOpen ? ' open' : ''}${failed ? ' error' : ''}`}>
      <button className="subagent-line" aria-expanded={isOpen} onClick={() => setOpen(!isOpen)} title={description}>
        <span className="sub-mark" aria-hidden="true">
          {running ? <span className="spinner small" /> : failed ? <ErrorIcon size={13} /> : <BotIcon size={13} />}
        </span>
        <span className="sub-kind">{kind}</span>
        <span className="sub-desc">{description}</span>
        <span className={`sub-status${running ? ' running' : ''}`}>{status}</span>
        <Chevron open={isOpen} size={14} />
      </button>
      {isOpen && (
        <div className="sub-body">
          {typeof i.prompt === 'string' && i.prompt.trim() && <FoldText text={i.prompt} label="Prompt" />}
          {steps.length > 0 && (
            <ol className="steps">
              {steps.map((s) => (
                <StepRow key={s.key} step={s} ctx={ctx} running={s === current} />
              ))}
            </ol>
          )}
          {steps.length === 0 && !running && !liveItems && tool.result !== undefined && !loaded && !loadError && <div className="sub-note">Loading its steps…</div>}
          {loaded && loaded.length === 0 && <div className="sub-note">Its transcript is not available.</div>}
          {loadError && <div className="sub-note error">Could not load its steps: {loadError}</div>}
          {reply && (
            <div className="prose sub-reply">
              <Markdown text={reply} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Text folded after a few lines, with its label. */
function FoldText({ text, label }: { text: string; label: string }) {
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = body.current;
    if (el && !open) setLong(el.scrollHeight > el.clientHeight + 2);
  }, [text, open]);
  return (
    <div className="sub-prompt">
      <div className="sub-prompt-label">{label}</div>
      <div className={`message-body${open ? ' open' : ''}`} ref={body} style={{ ['--fold-lines' as string]: 4 }}>
        {text}
      </div>
      {(long || open) && (
        <button className="fold-toggle" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

const MAX_OUTPUT = 20_000;

function StepRow({ step, ctx, running }: { step: Step; ctx: Ctx; running: boolean }) {
  const error = step.kind === 'tool' && (step.isError === true || step.denied !== undefined);
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? ctx.verbose;
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
  const { permissions } = useManager();
  const asked = step.kind === 'tool' ? permissionFor(step.id, { permissions }) : undefined;
  const outcome = asked && asked.status !== 'pending' ? PERMISSION_OUTCOME[asked.status] : null;

  return (
    <li className={`step${error ? ' error' : ''}${running ? ' running' : ''}`}>
      <button className="step-head" aria-expanded={isOpen} onClick={() => setOpen(!isOpen)}>
        <span className="step-icon">{running ? <span className="spinner small" /> : error ? <ErrorIcon size={14} /> : view.icon}</span>
        <span className="step-label">
          {view.label}
          {view.detail && <span className="step-detail mono"> {view.detail}</span>}
        </span>
        {view.meta && <span className="step-meta mono">{view.meta}</span>}
        {outcome && <span className="step-meta">{outcome}</span>}
        {unfinished && <span className="step-meta">no result</span>}
        {ms !== null && ms >= 1000 && <span className="step-time mono">{duration(ms)}</span>}
      </button>
      {isOpen && <StepBody step={step} agentId={ctx.agent.id} />}
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
    case 'show_visual':
      return {
        icon: <VisualIcon size={14} />,
        label: step.result === undefined ? 'Drawing a visual' : step.isError ? 'Visual not shown' : 'Showed a visual',
        detail: firstLine(i.title, 80),
      };
    case 'TodoWrite':
      return { icon: <TodoIcon size={14} />, label: 'Updated the to-do list', meta: Array.isArray(i.todos) ? `${i.todos.length} items` : undefined };
    default:
      return { icon: <ToolIcon size={14} />, label: name, detail: summarize(step, agents) };
  }
}

const PERMISSION_OUTCOME: Record<Exclude<PermissionRequest['status'], 'pending'>, string> = {
  allowed: 'allowed by you',
  allowedSession: 'allowed for this session',
  denied: 'denied by you',
  cancelled: 'permission cancelled',
};

/**
 * A tool call auto mode couldn't decide on. The turn is paused until the user answers, interrupts or
 * stops the agent. Deny can carry a note for the agent.
 */
function PermissionView({ request, ctx, autoFocus }: { request: PermissionRequest; ctx: Ctx; autoFocus: boolean }) {
  const [note, setNote] = useState('');
  const [noting, setNoting] = useState(false);
  const [busy, setBusy] = useState(false);
  const denyRef = useRef<HTMLButtonElement>(null);
  const allowRef = useRef<HTMLButtonElement>(null);
  const step: ToolItem = { kind: 'tool', key: request.id, id: request.toolUseId, name: request.toolName, input: request.input, startedAt: Date.parse(request.createdAt) };
  const view = stepView(step, ctx.agents);
  const since = duration(ctx.now - Date.parse(request.createdAt));
  // The SDK's description often repeats the call's own description, which the step line already shows.
  const description = request.description && request.description !== request.input.description && request.description !== view.label ? request.description : '';

  // The first waiting request takes the focus, on Deny when the SDK says it must not be one keystroke away.
  useEffect(() => {
    if (autoFocus) (request.defaultToNo ? denyRef : allowRef).current?.focus({ preventScroll: true });
  }, [autoFocus, request.defaultToNo]);

  const answer = async (decision: PermissionDecision) => {
    if (busy) return;
    setBusy(true);
    await ctx.run(async () => {
      store.upsertPermission(await commands.answerPermission(request.agentId, request.id, decision, decision === 'deny' ? note : undefined));
    });
    setBusy(false);
  };

  return (
    <section className="permission" aria-label="Permission needed">
      <div className="plan-head">
        <h3 className="plan-title">{request.title ?? `${ctx.agent.name} wants to use ${displayName(request.toolName)}`}</h3>
        <span className="plan-state waiting">Waiting for you · {since}</span>
      </div>
      <div className="permission-body">
        <div className="permission-call">
          <span className="step-icon">{view.icon}</span>
          <span className="step-label">
            {view.label}
            {view.detail && <span className="step-detail mono"> {view.detail}</span>}
          </span>
          {view.meta && <span className="step-meta mono">{view.meta}</span>}
        </div>
        <StepBody step={step} />
        {(request.reason || description || request.blockedPath) && (
          <div className="permission-reason">
            {description && <div>{description}</div>}
            {request.reason && <div>{request.reason}</div>}
            {request.blockedPath && (
              <div>
                Outside the allowed folders: <span className="mono">{request.blockedPath}</span>
              </div>
            )}
          </div>
        )}
        {noting && (
          <textarea
            className="permission-note"
            rows={2}
            autoFocus
            placeholder="Tell the agent why, or what to do instead (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.shiftKey && continueList(e)) return;
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void answer('deny');
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setNoting(false);
              }
            }}
          />
        )}
      </div>
      <div className="plan-foot">
        <span className="plan-foot-text">Auto mode couldn't decide on this. The agent waits until you answer.</span>
        {noting ? (
          <>
            <button className="button secondary small" disabled={busy} onClick={() => setNoting(false)}>
              Back
            </button>
            <button className="button secondary small danger" ref={denyRef} disabled={busy} onClick={() => void answer('deny')}>
              Deny
            </button>
          </>
        ) : (
          <>
            <button className="button secondary small" ref={denyRef} disabled={busy} onClick={() => setNoting(true)} title="Deny, with an optional note for the agent">
              Deny…
            </button>
            {request.canAllowSession && (
              <button
                className="button secondary small"
                disabled={busy}
                onClick={() => void answer('allowSession')}
                title="Allow this and similar calls until the agent's process closes"
              >
                Allow for this session
              </button>
            )}
            <button className="button primary small" ref={allowRef} disabled={busy} onClick={() => void answer('allow')}>
              Allow
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function StepBody({ step, agentId }: { step: Step; agentId?: string }) {
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
        <FilePath path={i.file_path} agentId={agentId} mode="diff" />
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
        <FilePath path={i.file_path} agentId={agentId} mode="file" />
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

/** A tool's file path; in an agent's own transcript it opens the file (or its changes) in the Files panel. */
function FilePath({ path, agentId, mode }: { path: unknown; agentId?: string; mode: 'file' | 'diff' }) {
  const full = String(path ?? '');
  if (!agentId || !full) {
    return (
      <div className="diff-path mono" title={full}>
        {shortPath(path)}
      </div>
    );
  }
  return (
    <div className="diff-path mono">
      <button className="file-link" title={`${full}
${mode === 'diff' ? 'Show the changes' : 'Open the file'} in the Files panel`} onClick={() => fileLinks.open({ agentId, path: full, mode })}>
        {shortPath(path)}
      </button>
    </div>
  );
}

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
      <span>
        {!reply.isError && !reply.interrupted && <CheckIcon size={13} className="done-check" aria-hidden="true" />}
        {parts.join(' · ')}
      </span>
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
