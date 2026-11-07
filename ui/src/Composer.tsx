import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { commands, type AgentRecord, type CommandOption, type ImageData, type QueuedMessage } from './api';
import { useNow } from './hooks';
import { AttachImageIcon, CloseIcon, SendIcon } from './icons';
import { agentState, deliverable, isHeld } from './status';
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
  const images = useAttachments(agent.id);
  const running = agent.status === 'running';
  const { plans, questionSets } = useManager();
  // A plan or a question set waits for the user: the composer says it never carries their state.
  const pending = agent.kind === 'orchestrator' ? pendingFor(agent.id, { plans, questionSets }) : { plan: null, questions: 0 };
  const decision = pending.plan
    ? { placeholder: 'Answer, add context, or ask for a different plan', hint: 'Enter sends just your message, never the checkboxes' }
    : pending.questions
      ? { placeholder: `Message ${agent.name}`, hint: 'Enter sends just your message; the open questions fold away' }
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

  // Grow with the text; CSS caps the height. Measure again when the width changes (a pane opening or resizing).
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);

  // Esc interrupts the running turn (the queue stays), unless something else handles it.
  useEffect(() => {
    if (!running || !focused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if ((e.target as HTMLElement | null)?.closest('.sidebar, .menu, .switcher, .files-panel')) return;
      e.preventDefault();
      onInterrupt();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running, focused, onInterrupt]);

  const send = async () => {
    const value = text.trim();
    const attached = images.list;
    if ((!value && attached.length === 0) || sending || images.busy) return;
    setSending(true);
    await run(async () => {
      await commands.send(agent.id, value, attached.map(({ mediaType, data }) => ({ mediaType, data })));
      // Keep anything typed or attached while the request was in flight.
      setText((current) => (current.trim() === value ? '' : current));
      images.remove(attached.map((a) => a.id));
    });
    setSending(false);
    box.current?.focus();
  };

  return (
    <div className="composer-dock">
      <div className="composer-column">
        {running && <LiveStatus agent={agent} agents={agents} />}
        <div
          className={`composer${images.dropping ? ' dropping' : ''}`}
          onDragEnter={images.onDragOver}
          onDragOver={images.onDragOver}
          onDragLeave={images.onDragLeave}
          onDrop={images.onDrop}
        >
          {menuOpen && (skills.list === null || matches.length > 0) && (
            <SlashMenu matches={matches} loading={skills.list === null} error={skills.error} active={active} onHover={setMenuIndex} onPick={fillCommand} />
          )}
          {agent.notificationsPaused && <Paused agent={agent} run={run} />}
          {deliverable(agent).length > 0 && <Queue agent={agent} run={run} />}
          <div className="composer-body">
            {images.list.length > 0 && (
              <div className="attachments" aria-label="Images to send">
                {images.list.map((a) => (
                  <div key={a.id} className="attachment" title={a.name}>
                    <img src={a.url} alt={a.name} />
                    <button className="attachment-remove" aria-label={`Remove ${a.name}`} title="Remove" onClick={() => images.remove([a.id])}>
                      <CloseIcon size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={box}
              rows={2}
              value={text}
              aria-label={running ? `Queue a message for ${agent.name}` : `Message ${agent.name}`}
              placeholder={running ? `Queue a message for ${agent.name}` : (decision?.placeholder ?? `Message ${agent.name}`)}
              onChange={(e) => setText(e.target.value)}
              onPaste={images.onPaste}
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
              <button
                className="icon-button"
                aria-label="Attach images"
                title="Attach images (or paste or drop them here)"
                disabled={images.list.length >= MAX_IMAGES}
                onClick={() => images.pick()}
              >
                <AttachImageIcon size={16} />
              </button>
              {images.input}
              <span className={`composer-hint${images.error ? ' error' : ''}`}>
                {images.error || (running ? 'Enter queues it for after this turn' : decision?.hint)}
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
                disabled={(!text.trim() && images.list.length === 0) || sending || images.busy}
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

// ---------- images ----------

const MAX_IMAGES = 10;
const IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** The API scales larger images down to this anyway. */
const MAX_EDGE = 1568;
/** Under the API's 5 MB of base64 per image, with room to spare. */
const MAX_BYTES = 3.5 * 1024 * 1024;

type Attachment = ImageData & { id: string; url: string; name: string };

let attachmentSeq = 0;

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image'));
    reader.readAsDataURL(blob);
  });
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Keep small images as they are; scale large ones (or other formats) down and re-encode them as WebP. */
async function prepareImage(file: File): Promise<Attachment> {
  let blob: Blob = file;
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (!IMAGE_TYPES.includes(file.type) || scale < 1 || file.size > MAX_BYTES) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const webp = await canvasBlob(canvas, 'image/webp', 0.9);
      blob = webp?.type === 'image/webp' ? webp : ((await canvasBlob(canvas, 'image/jpeg', 0.88)) ?? file);
    }
  } finally {
    bitmap.close();
  }
  if (blob.size > MAX_BYTES) throw new Error('it is too large even after scaling it down');
  const url = await readDataUrl(blob);
  return {
    id: `img-${++attachmentSeq}`,
    mediaType: blob.type as ImageData['mediaType'],
    data: url.slice(url.indexOf(',') + 1),
    url,
    name: file.name || 'Pasted image',
  };
}

/** Images waiting to be sent with the next message: added by paste, drop or the picker. */
function useAttachments(agentId: string) {
  const [list, setList] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dropping, setDropping] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setList([]);
    setError('');
  }, [agentId]);

  const add = async (files: File[]) => {
    const wanted = files.filter((f) => f.type.startsWith('image/'));
    if (wanted.length === 0) return;
    setBusy(true);
    setError('');
    let room = MAX_IMAGES - list.length;
    for (const file of wanted) {
      if (room <= 0) {
        setError(`At most ${MAX_IMAGES} images per message`);
        break;
      }
      try {
        const image = await prepareImage(file);
        room--;
        setList((current) => (current.length >= MAX_IMAGES ? current : [...current, image]));
      } catch (err) {
        setError(`Could not add ${file.name || 'the image'}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setBusy(false);
  };

  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');
  return {
    list,
    busy,
    error,
    dropping,
    remove: (ids: string[]) => setList((current) => current.filter((a) => !ids.includes(a.id))),
    pick: () => fileInput.current?.click(),
    input: (
      <input
        ref={fileInput}
        type="file"
        accept={IMAGE_TYPES.join(',')}
        multiple
        hidden
        onChange={(e) => {
          void add([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
    ),
    onPaste: (e: React.ClipboardEvent) => {
      const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
      if (files.length === 0) return;
      // A copied image may come with text (its name or HTML): the image is what was meant.
      if (!e.clipboardData.getData('text/plain')) e.preventDefault();
      void add(files);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      setDropping(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropping(false);
      void add([...e.dataTransfer.files]);
    },
  };
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

/** Expert notifications are paused: how many wait, and the way to let them through. */
function Paused({ agent, run }: { agent: AgentRecord; run: (a: () => Promise<unknown>) => Promise<void> }) {
  const held = agent.queue.filter((m) => isHeld(agent, m)).length;
  return (
    <div className="paused-notifications" role="status">
      <span className="paused-text">
        Expert notifications paused
        <span className="paused-count mono"> · {held === 0 ? 'none held' : `${held} held`}</span>
      </span>
      <button
        className="link-button"
        title={held > 1 ? 'Delivers the held notifications to the chat as one message' : 'Delivers notifications to the chat again'}
        onClick={() => void run(() => commands.setNotificationsPaused(agent.id, false))}
      >
        Resume
      </button>
    </div>
  );
}

function Queue({ agent, run }: { agent: AgentRecord; run: (a: () => Promise<unknown>) => Promise<void> }) {
  const queue = deliverable(agent);
  return (
    <div className="queue" aria-label="Queued messages">
      <div className="queue-title mono">Queued · {queue.length}</div>
      {queue.map((m: QueuedMessage) => {
        const { source, text } = parsePrompt(m.text);
        const from = source.kind === 'user' ? 'You' : source.kind === 'orchestrator' ? source.name : source.kind === 'manager' ? 'Manager' : 'Claude Code';
        return (
          <div key={m.id} className="queue-item" title={text}>
            <span className="queue-source">{from}</span>
            <span className="queue-text">
              {text}
              {m.images?.length ? <span className="queue-images">{text ? ' · ' : ''}{m.images.length === 1 ? '1 image' : `${m.images.length} images`}</span> : null}
            </span>
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
    return sessionStorage.getItem(`centurion-draft:${id}`) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(id: string, text: string): void {
  try {
    if (text) sessionStorage.setItem(`centurion-draft:${id}`, text);
    else sessionStorage.removeItem(`centurion-draft:${id}`);
  } catch {
    // drafts are a convenience only
  }
}
