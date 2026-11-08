import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { commands, type AgentRecord, type CommandOption, type ImageData, type QueuedMessage } from './api';
import { useNow } from './hooks';
import { AttachImageIcon, CloseIcon, MicIcon, SendIcon } from './icons';
import { createDictation, dictationSupported } from './dictation';
import { agentState, deliverable, isHeld } from './status';
import { composerFill, lastSeen, pendingFor, transcriptPin, useManager } from './store';
import { parsePrompt } from './timeline';
import { continueList, indentList } from './listInput';
import { baseName, dirName, filterPaths, filesApi, type Root } from './fileStore';
import { promptHistory, type Recalled } from './promptHistory';

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

  // Speech to text (browser speech recognition, English): each final phrase goes in at the caret.
  const [dictating, setDictating] = useState<{ listening: boolean; error: string | null }>({ listening: false, error: null });
  const textNow = useRef(text);
  textNow.current = text;
  const dictateAt = useRef(0);
  const dictation = useRef<ReturnType<typeof createDictation> | null>(null);
  if (!dictation.current) {
    dictation.current = createDictation(
      (said) => {
        const current = textNow.current;
        const at = Math.min(dictateAt.current, current.length);
        const before = current.slice(0, at);
        const inserted = (before && !/\s$/.test(before) ? ' ' : '') + said + ' ';
        const next = before + inserted + current.slice(at);
        textNow.current = next;
        dictateAt.current = at + inserted.length;
        setText(next);
        pendingCaret.current = dictateAt.current;
        setHistory(null);
      },
      setDictating,
    );
  }
  useEffect(() => {
    setDictating({ listening: false, error: null });
    const d = dictation.current;
    return () => d?.abort();
  }, [agent.id]);
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

  // File mentions: `@` at the start or after a space, up to the caret.
  const [caret, setCaret] = useState(0);
  const pendingCaret = useRef<number | null>(null);
  const mention = slash ? null : findMention(text, caret);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionClosedAt, setMentionClosedAt] = useState<string | null>(null);
  const mentionOpen = mention !== null && mentionClosedAt !== text;
  const mentionFiles = useMentionFiles(agent.id, mention !== null);
  const mentionMatches = mentionOpen && mentionFiles.list ? matchMentions(mentionFiles.list, mention.query) : [];
  const mentionActive = Math.min(mentionIndex, Math.max(0, mentionMatches.length - 1));
  useEffect(() => setMentionIndex(0), [mention?.query]);
  const fillMention = (m: MentionOption) => {
    if (!mention) return;
    const inserted = `@${/\s/.test(m.value) ? `"${m.value}"` : m.value} `;
    setText(text.slice(0, mention.start) + inserted + text.slice(caret));
    pendingCaret.current = mention.start + inserted.length;
    setMentionClosedAt(null);
    box.current?.focus();
  };
  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null || !box.current) return;
    pendingCaret.current = null;
    box.current.setSelectionRange(at, at);
    setCaret(at);
  }, [text]);
  const trackCaret = () => {
    const el = box.current;
    if (el && el.selectionStart !== caret) setCaret(el.selectionStart);
  };

  // Prompt history: Up / Down walk through earlier prompts; `index` -1 is the draft you were typing.
  const [history, setHistory] = useState<{ list: Recalled[]; index: number; draft: string } | null>(null);
  useEffect(() => setHistory(null), [agent.id]);
  const recall = (step: 1 | -1): boolean => {
    const state = history ?? { list: promptHistory.for(agent.id), index: -1, draft: text };
    const index = state.index + step;
    if (index < -1 || index >= state.list.length) return false;
    const next = index === -1 ? state.draft : state.list[index].text;
    setHistory(index === -1 ? null : { ...state, index });
    setText(next);
    pendingCaret.current = next.length;
    return true;
  };
  const recalled = history ? history.list[history.index] : null;
  const recalledFrom = recalled && recalled.agentId !== agent.id ? (agents.get(recalled.agentId)?.name ?? 'another agent') : null;

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
    dictation.current?.stop();
    setSending(true);
    // Your own message should be in view when it lands, even if you had scrolled up.
    transcriptPin.set({ agentId: agent.id, at: Date.now() });
    await run(async () => {
      await commands.send(agent.id, value, attached.map(({ mediaType, data }) => ({ mediaType, data })));
      promptHistory.add(agent.id, value);
      setHistory(null);
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
          {mentionOpen && (mentionFiles.list === null || mentionFiles.error || mentionMatches.length > 0 || !mention.query) && (
            <MentionMenu
              matches={mentionMatches}
              loading={mentionFiles.list === null}
              error={mentionFiles.error}
              empty={!mention.query}
              active={mentionActive}
              onHover={setMentionIndex}
              onPick={fillMention}
            />
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
              onChange={(e) => {
                setText(e.target.value);
                setCaret(e.target.selectionStart);
                setHistory(null); // typing keeps the recalled text as your own
              }}
              onSelect={trackCaret}
              onPaste={images.onPaste}
              aria-autocomplete="list"
              aria-expanded={matches.length > 0 || mentionMatches.length > 0}
              aria-controls={matches.length > 0 ? 'slash-menu' : mentionMatches.length > 0 ? 'mention-menu' : undefined}
              aria-activedescendant={
                matches.length > 0 ? `slash-${active}` : mentionMatches.length > 0 ? `mention-${mentionActive}` : undefined
              }
              onKeyDown={(e) => {
                if (mentionMatches.length > 0 && !e.nativeEvent.isComposing) {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    setMentionIndex((mentionActive + (e.key === 'ArrowDown' ? 1 : mentionMatches.length - 1)) % mentionMatches.length);
                    return;
                  }
                  if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                    e.preventDefault();
                    fillMention(mentionMatches[mentionActive]);
                    return;
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setMentionClosedAt(text);
                    return;
                  }
                }
                if (
                  (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
                  !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey &&
                  !e.nativeEvent.isComposing &&
                  matches.length === 0
                ) {
                  const el = e.currentTarget;
                  const collapsed = el.selectionStart === el.selectionEnd;
                  const firstLine = !el.value.slice(0, el.selectionStart).includes('\n');
                  const lastLine = !el.value.slice(el.selectionEnd).includes('\n');
                  // Up: from an empty box, while walking the history, or with the caret at the very start.
                  const up = e.key === 'ArrowUp' && collapsed && firstLine && (!el.value || history !== null || el.selectionStart === 0);
                  const down = e.key === 'ArrowDown' && collapsed && lastLine && history !== null;
                  if ((up || down) && recall(up ? 1 : -1)) {
                    e.preventDefault();
                    return;
                  }
                }
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
                if ((e.shiftKey && continueList(e)) || indentList(e)) return;
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
              {dictationSupported() && (
                <button
                  className={`icon-button${dictating.listening ? ' dictating' : ''}`}
                  aria-label={dictating.listening ? 'Stop dictation' : 'Dictate (English)'}
                  aria-pressed={dictating.listening}
                  title={dictating.listening ? 'Stop dictation' : 'Dictate in English (speech to text in this browser)'}
                  onClick={() => {
                    dictateAt.current = box.current?.selectionStart ?? text.length;
                    dictation.current?.toggle();
                  }}
                >
                  <MicIcon size={16} />
                </button>
              )}
              {images.input}
              <span className={`composer-hint${images.error || dictating.error ? ' error' : ''}`}>
                {images.error ||
                  dictating.error ||
                  (dictating.listening
                    ? 'Listening in English · click the mic to stop'
                    : history
                    ? `Earlier prompt${recalledFrom ? ` to ${recalledFrom}` : ''} · ${history.index + 1} of ${history.list.length} · ↑ older, ↓ newer`
                    : running
                      ? 'Enter queues it for after this turn'
                      : decision?.hint)}
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

// ---------- file mentions ----------

/** The `@query` the caret is in: `@` at the start or after whitespace, the query running up to the caret. */
function findMention(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@([^\s@"]*)$/.exec(text.slice(0, caret));
  return m ? { start: m.index + m[1].length, query: m[2] } : null;
}

type MentionOption = {
  /** What goes after the `@`: relative to the agent's folder, absolute for its other roots. */
  value: string;
  name: string;
  dir: string;
  folder: boolean;
  /** The root's name, for roots other than the agent's own folder. */
  rootName: string | null;
};

type MentionRoot = { root: Root; index: number; paths: string[] };

/** Every file and folder of the agent's roots, fetched when a mention starts and reused for a minute. */
const mentionCache = new Map<string, { roots: MentionRoot[]; at: number }>();

function useMentionFiles(agentId: string, active: boolean): { list: MentionRoot[] | null; error: string | null } {
  const [state, setState] = useState<{ id: string; list: MentionRoot[] | null; error: string | null }>(() => ({
    id: agentId,
    list: mentionCache.get(agentId)?.roots ?? null,
    error: null,
  }));
  useEffect(() => {
    if (!active) return;
    const cached = mentionCache.get(agentId);
    if (cached) setState({ id: agentId, list: cached.roots, error: null });
    if (cached && Date.now() - cached.at < 60_000) return;
    let live = true;
    (async () => {
      const { roots } = await filesApi.roots(agentId);
      return Promise.all(
        roots.map(async (root, index): Promise<MentionRoot> => {
          const { files } = await filesApi.all(agentId, index);
          const folders = new Set<string>();
          for (const f of files) for (let d = dirName(f); d && !folders.has(d); d = dirName(d)) folders.add(d);
          return { root, index, paths: [...[...folders].map((d) => `${d}/`), ...files] };
        }),
      );
    })().then(
      (roots) => {
        mentionCache.set(agentId, { roots, at: Date.now() });
        if (live) setState({ id: agentId, list: roots, error: null });
      },
      (err: unknown) => live && setState({ id: agentId, list: cached?.roots ?? [], error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
  }, [agentId, active]);
  return state.id === agentId ? state : { list: mentionCache.get(agentId)?.roots ?? null, error: null };
}

/** The agent's own folder first, then its other roots; folders end in `/`. */
function matchMentions(roots: MentionRoot[], query: string): MentionOption[] {
  if (!query) return [];
  const out: MentionOption[] = [];
  for (const r of roots) {
    for (const p of filterPaths(r.paths, query, 30 - out.length)) {
      const folder = p.endsWith('/');
      const rel = folder ? p.slice(0, -1) : p;
      const absolute = `${r.root.path.replace(/\\/g, '/').replace(/\/$/, '')}/${rel}`;
      out.push({
        value: (r.index === 0 ? rel : absolute) + (folder ? '/' : ''),
        name: baseName(rel) + (folder ? '/' : ''),
        dir: dirName(rel),
        folder,
        rootName: r.index === 0 ? null : r.root.name,
      });
    }
    if (out.length >= 30) break;
  }
  return out;
}

type MentionMenuProps = {
  matches: MentionOption[];
  loading: boolean;
  error: string | null;
  /** Just `@` so far. */
  empty: boolean;
  active: number;
  onHover: (index: number) => void;
  onPick: (m: MentionOption) => void;
};

function MentionMenu({ matches, loading, error, empty, active, onHover, onPick }: MentionMenuProps) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector(`#mention-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return (
    <div className="slash-menu" id="mention-menu" role="listbox" aria-label="Files and folders" ref={list}>
      {loading && <div className="slash-note">Loading files…</div>}
      {error && <div className="slash-note">Could not load the files: {error}</div>}
      {!loading && !error && empty && <div className="slash-note">Type to find a file or folder</div>}
      {matches.map((m, n) => (
        <div
          key={m.value}
          id={`mention-${n}`}
          role="option"
          aria-selected={n === active}
          className={`slash-item mention-item${n === active ? ' active' : ''}`}
          onMouseEnter={() => onHover(n)}
          onMouseDown={(e) => {
            e.preventDefault(); // keep the focus in the box
            onPick(m);
          }}
        >
          <span className="slash-name mono">{m.name}</span>
          <span className="slash-description mono">
            {m.rootName && <span className="mention-root">{m.rootName}</span>}
            {m.rootName && m.dir ? ' / ' : ''}
            {m.dir}
          </span>
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
