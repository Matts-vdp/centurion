/**
 * Visual markup: the small JSX-like language agents use with `show_visual` (docs/visuals-research.md).
 * Boxes (Row, Column, Card), lines (Tree and Timeline with Item), details (More), Code, Bars and Image:
 * string attributes and flags, text inside elements. It is parsed into a tree and drawn by the UI's own
 * components; nothing is ever run or inserted as HTML. Used by the tool (to return errors to the agent) and
 * by the UI (to draw it), so this module has no Node or DOM dependencies.
 */

/** Lucide icon names (kebab case) an agent may use. The UI maps each to its component. */
export const VISUAL_ICONS = [
  'check', 'x', 'circle-check', 'circle-x', 'circle-alert', 'triangle-alert', 'info', 'circle-help', 'ban',
  'circle-dot', 'circle-slash', 'clock', 'hourglass', 'history', 'loader', 'star', 'flag', 'lightbulb', 'target',
  'zap', 'sparkles', 'code', 'terminal', 'square-function', 'bug', 'git-branch', 'git-merge', 'git-pull-request',
  'git-commit-horizontal', 'git-compare', 'package', 'box', 'boxes', 'puzzle', 'wrench', 'settings', 'flask-conical',
  'file', 'file-text', 'file-code', 'file-json', 'file-diff', 'folder', 'folder-open', 'image', 'database', 'server',
  'cloud', 'globe', 'network', 'plug', 'cpu', 'layers', 'layout-template', 'workflow', 'route', 'list-tree',
  'list-checks', 'list', 'table', 'chart-column', 'chart-line', 'gauge', 'user', 'users', 'bot', 'brain',
  'message-square', 'mail', 'bell', 'eye', 'search', 'key-round', 'lock', 'lock-open', 'shield', 'shield-check',
  'arrow-right', 'repeat', 'refresh-cw', 'split', 'merge', 'play', 'pause', 'rocket', 'timer', 'hard-drive',
  'monitor', 'smartphone', 'calendar', 'link', 'download', 'upload', 'trash-2', 'pencil', 'plus', 'minus', 'tag',
  'scale', 'trending-up', 'trending-down', 'coins',
] as const;
export type VisualIcon = (typeof VISUAL_ICONS)[number];

export const VISUAL_TONES = ['accent', 'ok', 'warn', 'bad', 'running'] as const;
export type VisualTone = (typeof VISUAL_TONES)[number];

export type VisualContainer = {
  type: 'row' | 'column';
  arrows: boolean;
  /** Label of the arrow leading into this element. */
  arrow?: string;
  children: VisualNode[];
  line: number;
};

/** Collapsed details: text and code, never boxes. */
export type VisualMore = { parts: ({ type: 'text'; text: string } | VisualCode)[] };

export type VisualCard = {
  type: 'card';
  title: string;
  icon?: VisualIcon;
  /** Body text: plain text, `code` spans allowed. */
  text?: string;
  /** A key number; the title is its label. */
  value?: string;
  /** Next to the key number: "+3%", "−81%". */
  change?: string;
  /** Quiet text on the right of the title: a time, a size, a line number. */
  meta?: string;
  /** A thin meter: fraction 0–1 and the label as written ("3/5", "60%"). */
  progress?: { fraction: number; label: string };
  tone?: VisualTone;
  badge?: string;
  repo?: string;
  /** `expert:<name>`, `file:<path>[:<line>]` or an http(s) URL. */
  link?: string;
  arrow?: string;
  more?: VisualMore;
  children: VisualNode[];
  line: number;
};

/** A line in a Tree (nests) or a Timeline (has `when`). */
export type VisualItem = {
  type: 'item';
  title: string;
  icon?: VisualIcon;
  tone?: VisualTone;
  /** A short note: beside the title in a tree, under it in a timeline. */
  text?: string;
  meta?: string;
  link?: string;
  when?: string;
  /** Tree only: starts folded. */
  collapsed: boolean;
  more?: VisualMore;
  children: VisualItem[];
  line: number;
};

export type VisualTree = { type: 'tree'; arrow?: string; children: VisualItem[]; line: number };
export type VisualTimeline = { type: 'timeline'; arrow?: string; children: VisualItem[]; line: number };

export type VisualBar = { label: string; value: number; shown: string; tone?: VisualTone; line: number };
export type VisualBars = { type: 'bars'; title?: string; unit?: string; arrow?: string; bars: VisualBar[]; line: number };

export type VisualImage = { type: 'image'; src: string; caption?: string; arrow?: string; line: number };

export type VisualCode = {
  type: 'code';
  /** Dedented, as written: never entity-decoded. */
  code: string;
  lang?: string;
  /** A path in the agent's folders (no `file:`). */
  file?: string;
  /** The file's line number of the first line. */
  start?: number;
  /** Lines to highlight, in the same numbering as the gutter. */
  mark: number[];
  arrow?: string;
  line: number;
};

export type VisualNode = VisualContainer | VisualCard | VisualTree | VisualTimeline | VisualBars | VisualImage | VisualCode;

export type VisualIssue = { line: number; message: string };

export type VisualParse = {
  nodes: VisualNode[];
  /** Any error means the visual is not shown. */
  errors: VisualIssue[];
  /** Shown anyway; the agent hears about them. */
  warnings: VisualIssue[];
};

export const VISUAL_LIMITS = {
  depth: 4,
  treeDepth: 6,
  elements: 60,
  rowChildren: 4,
  bars: 12,
  codeLines: 30,
  title: 80,
  text: 300,
  more: 600,
  badge: 24,
  value: 16,
  arrow: 30,
};

const ELEMENTS = {
  row: 'Row',
  column: 'Column',
  card: 'Card',
  tree: 'Tree',
  timeline: 'Timeline',
  item: 'Item',
  more: 'More',
  code: 'Code',
  bars: 'Bars',
  bar: 'Bar',
  image: 'Image',
} as const;
type ElementType = keyof typeof ELEMENTS;
const ELEMENT_LIST = 'Row, Column, Card, Tree, Timeline, Item, More, Code, Bars, Bar or Image';

const ATTRS: Record<ElementType, string[]> = {
  row: ['arrows', 'arrow'],
  column: ['arrows', 'arrow'],
  card: ['title', 'icon', 'tone', 'badge', 'value', 'change', 'meta', 'progress', 'repo', 'link', 'arrow'],
  tree: ['arrow'],
  timeline: ['arrow'],
  item: ['title', 'icon', 'tone', 'note', 'meta', 'link', 'when', 'collapsed'],
  more: [],
  code: ['lang', 'file', 'line', 'mark', 'arrow'],
  bars: ['title', 'unit', 'arrow'],
  bar: ['label', 'value', 'tone'],
  image: ['src', 'caption', 'arrow'],
};
/** Elements that are blocks: they go at the top, in a Row or Column, or in a Card. */
const BLOCKS = new Set<ElementType>(['row', 'column', 'card', 'tree', 'timeline', 'bars', 'image', 'code']);
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
const MAX_ISSUES = 12;

type Attr = { value: string | true; line: number };
type Text = { text: string; line: number };
type RawCode = { raw: string; line: number };
type Raw = { type: ElementType; attrs: Map<string, Attr>; children: (Raw | Text | RawCode)[]; line: number };

class Scanner {
  pos = 0;
  line = 1;
  constructor(readonly src: string) {}
  get done(): boolean {
    return this.pos >= this.src.length;
  }
  peek(n = 0): string {
    return this.src[this.pos + n] ?? '';
  }
  startsWith(s: string): boolean {
    return this.src.startsWith(s, this.pos);
  }
  next(): string {
    const c = this.src[this.pos++] ?? '';
    if (c === '\n') this.line++;
    return c;
  }
  skipSpace(): void {
    while (!this.done && /\s/.test(this.peek())) this.next();
  }
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };

function decode(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Code as the agent indented it inside the markup: drop the blank first and last lines and the common indent. */
export function dedent(raw: string): string {
  const lines = raw.replace(/\t/g, '  ').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length));
  return lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0).trimEnd()).join('\n');
}

/** "42", "42-44" or "40, 42-43" into line numbers. Null when it doesn't parse. */
function parseMark(s: string): number[] | null {
  const out: number[] = [];
  for (const part of s.split(',')) {
    const m = /^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/.exec(part);
    if (!m) return null;
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    if (to < from || to - from > 200) return null;
    for (let n = from; n <= to; n++) out.push(n);
  }
  return out;
}

/** Splits `file:path:42` into the path and the line. */
export function splitFileLink(link: string): { path: string; line?: number } {
  const p = link.replace(/^file:/, '').trim();
  const m = /^(.*\S):(\d+)$/.exec(p);
  return m ? { path: m[1], line: Number(m[2]) } : { path: p };
}

/** Parse visual markup. Never throws. */
export function parseVisual(markup: string): VisualParse {
  const errors: VisualIssue[] = [];
  const warnings: VisualIssue[] = [];
  const err = (line: number, message: string) => {
    if (errors.length < MAX_ISSUES) errors.push({ line, message });
  };
  const warn = (line: number, message: string) => {
    if (warnings.length < MAX_ISSUES) warnings.push({ line, message });
  };

  // ---------- tags into a raw tree ----------
  const s = new Scanner(markup.replace(/\r\n?/g, '\n'));
  const top: Raw = { type: 'column', attrs: new Map(), children: [], line: 1 };
  const stack: Raw[] = [top];
  let text = '';
  let textLine = 1;
  const flushText = () => {
    if (text.trim()) stack[stack.length - 1].children.push({ text: decode(text), line: textLine });
    text = '';
  };

  while (!s.done) {
    if (s.startsWith('<!--')) {
      flushText();
      const end = s.src.indexOf('-->', s.pos + 4);
      const stop = end < 0 ? s.src.length : end + 3;
      while (s.pos < stop) s.next();
      continue;
    }
    if (s.peek() === '<' && /[A-Za-z/]/.test(s.peek(1))) {
      flushText();
      const line = s.line;
      s.next();
      const closing = s.peek() === '/';
      if (closing) s.next();
      let name = '';
      while (/[A-Za-z0-9_.-]/.test(s.peek())) name += s.next();
      const type = elementType(name);
      if (!type) err(line, `<${name}> is not an element; use ${ELEMENT_LIST}.`);

      if (closing) {
        s.skipSpace();
        if (s.peek() === '>') s.next();
        else err(line, `</${name}> is missing its ">".`);
        if (!type) continue;
        const open = stack.length > 1 ? stack[stack.length - 1] : null;
        if (!open) err(line, `</${ELEMENTS[type]}> has no matching opening tag.`);
        else if (open.type !== type) {
          err(line, `</${ELEMENTS[type]}> closes <${ELEMENTS[open.type]}> from line ${open.line}; close that one first.`);
          // Recover: pop up to a matching element if there is one.
          const at = stack.findLastIndex((r, i) => i > 0 && r.type === type);
          if (at > 0) stack.length = at;
        } else stack.pop();
        continue;
      }

      const attrs = new Map<string, Attr>();
      let selfClosing = false;
      for (;;) {
        s.skipSpace();
        if (s.done) {
          err(line, `<${name}> is never finished; it needs ">" or "/>".`);
          break;
        }
        if (s.peek() === '>') {
          s.next();
          break;
        }
        if (s.startsWith('/>')) {
          s.next();
          s.next();
          selfClosing = true;
          break;
        }
        const attrLine = s.line;
        let key = '';
        while (/[A-Za-z0-9_:-]/.test(s.peek())) key += s.next();
        if (!key) {
          err(attrLine, `Unexpected "${s.peek()}" in <${name}>. Attributes look like title="Text"; flags like arrows stand alone.`);
          // Skip to the end of the tag.
          while (!s.done && s.peek() !== '>') s.next();
          if (!s.done) s.next();
          break;
        }
        s.skipSpace();
        let value: string | true = true;
        if (s.peek() === '=') {
          s.next();
          s.skipSpace();
          const q = s.peek();
          if (q === '"' || q === "'") {
            s.next();
            let v = '';
            while (!s.done && s.peek() !== q) v += s.next();
            if (s.done) err(attrLine, `The value of ${key} is missing its closing ${q}.`);
            else s.next();
            value = decode(v);
          } else if (q === '{') {
            // Lenient with JSX habits: arrows={true}, title={"Text"}.
            s.next();
            let v = '';
            let depth = 1;
            while (!s.done) {
              const c = s.peek();
              if (c === '{') depth++;
              if (c === '}' && --depth === 0) break;
              v += s.next();
            }
            if (!s.done) s.next();
            const t = v.trim();
            if (t === 'true') value = true;
            else if (t === 'false') value = 'false';
            else if (/^-?\d+(\.\d+)?$/.test(t)) value = t;
            else if (/^(["'`])[\s\S]*\1$/.test(t)) value = t.slice(1, -1);
            else err(attrLine, `${key}={${t}} is code; write ${key}="text" instead.`);
          } else {
            let v = '';
            while (!s.done && !/[\s>]/.test(s.peek()) && !s.startsWith('/>')) v += s.next();
            value = v;
            warn(attrLine, `Put the value of ${key} in quotes: ${key}="${v}".`);
          }
        }
        if (attrs.has(key)) err(attrLine, `${key} appears twice on <${name}>.`);
        attrs.set(key, { value, line: attrLine });
      }
      if (!type) continue;
      const raw: Raw = { type, attrs, children: [], line };
      stack[stack.length - 1].children.push(raw);
      if (type === 'code' && !selfClosing) {
        // Everything up to </Code> is the code itself, taken literally.
        const end = /<\/code\s*>/i.exec(s.src.slice(s.pos));
        const stop = end ? s.pos + end.index : s.src.length;
        const codeLine = s.line;
        let body = '';
        while (s.pos < stop) body += s.next();
        raw.children.push({ raw: body, line: codeLine });
        if (end) for (let i = 0; i < end[0].length; i++) s.next();
        else err(line, `<Code> from line ${line} is never closed; end the code with </Code>.`);
        continue;
      }
      if (!selfClosing) stack.push(raw);
      continue;
    }
    if (!text) textLine = s.line;
    text += s.next();
  }
  flushText();
  for (const open of stack.slice(1).reverse()) err(open.line, `<${ELEMENTS[open.type]}> from line ${open.line} is never closed.`);

  // ---------- raw tree into nodes, with checks ----------
  let count = 0;
  const counted = (raw: Raw) => {
    count++;
    if (count === VISUAL_LIMITS.elements + 1) err(raw.line, `More than ${VISUAL_LIMITS.elements} elements; keep a visual small and split it, or use Mermaid.`);
  };

  const checkAttrs = (raw: Raw) => {
    const allowed = ATTRS[raw.type];
    for (const [key, a] of raw.attrs) {
      if (allowed.includes(key)) continue;
      if (key === 'when' && raw.type === 'card') err(a.line, 'when belongs on an <Item> in a <Timeline>, not on a Card.');
      else if (allowed.length === 0) err(a.line, `<${ELEMENTS[raw.type]}> takes no attributes.`);
      else err(a.line, `<${ELEMENTS[raw.type]}> has no attribute ${key}; it takes ${allowed.join(', ')}.`);
    }
  };
  const str = (raw: Raw, key: string, max?: number): string | undefined => {
    const a = raw.attrs.get(key);
    if (!a) return undefined;
    if (a.value === true) {
      err(a.line, `${key} needs a value: ${key}="…".`);
      return undefined;
    }
    const v = a.value.replace(/\s+/g, ' ').trim();
    if (!v) return undefined;
    if (max && v.length > max) err(a.line, `${key} "${v.slice(0, 28)}…" is ${v.length} characters; keep it under ${max}.`);
    return v;
  };
  const flag = (raw: Raw, key: string): boolean => {
    const a = raw.attrs.get(key);
    if (!a) return false;
    if (a.value !== true && a.value !== 'true' && a.value !== 'false') err(a.line, `${key} is a flag: write it on its own, like <${ELEMENTS[raw.type]} ${key}>.`);
    return a.value !== 'false';
  };
  const iconOf = (raw: Raw): VisualIcon | undefined => {
    const name = str(raw, 'icon');
    if (!name) return undefined;
    if ((VISUAL_ICONS as readonly string[]).includes(name)) return name as VisualIcon;
    err(raw.attrs.get('icon')!.line, `icon "${name}" is not in the icon list.`);
    return undefined;
  };
  const toneOf = (raw: Raw): VisualTone | undefined => {
    const name = str(raw, 'tone');
    if (!name) return undefined;
    if ((VISUAL_TONES as readonly string[]).includes(name)) return name as VisualTone;
    err(raw.attrs.get('tone')!.line, `tone "${name}" is unknown; use ${VISUAL_TONES.join(', ')}.`);
    return undefined;
  };
  const linkOf = (raw: Raw): string | undefined => {
    const link = str(raw, 'link');
    if (link && !/^(expert:.+|file:.+|https?:\/\/\S+)$/.test(link)) {
      err(raw.attrs.get('link')!.line, `link "${link}" must be expert:<name>, file:<path> (or file:<path>:<line>) or an http(s) URL.`);
    }
    return link;
  };
  const arrowOf = (raw: Raw, incoming: boolean): string | undefined => {
    const arrow = str(raw, 'arrow', VISUAL_LIMITS.arrow);
    if (arrow && !incoming) {
      warn(
        raw.attrs.get('arrow')!.line,
        `arrow="${arrow}" was dropped: no arrow leads into this element. arrow labels the arrow coming in from the previous sibling, so the first child of an arrowed Column or Row has none, and the parent needs the arrows flag.`,
      );
    }
    return arrow;
  };
  const elementsOf = (raw: Raw) => raw.children.filter((c): c is Raw => 'type' in c);
  const textsOf = (raw: Raw) => raw.children.filter((c): c is Text => 'text' in c);
  const bodyOf = (raw: Raw, what: string, max: number): string | undefined => {
    const texts = textsOf(raw);
    const body = texts.map((t) => t.text).join(' ').replace(/\s+/g, ' ').trim();
    if (body.length > max) err(texts[0].line, `The text of ${what} is ${body.length} characters; keep it under ${max}.`);
    return body || undefined;
  };
  const misplaced = (raw: Raw, where: string) => {
    if (raw.type === 'item') err(raw.line, `<Item> goes in a Tree or a Timeline; ${where === 'Card' ? 'inside a Card, use a nested Card' : 'use a Card here'}.`);
    else if (raw.type === 'more') err(raw.line, '<More> goes inside a Card or an Item, once.');
    else if (raw.type === 'bar') err(raw.line, '<Bar> goes inside <Bars>.');
    else err(raw.line, `<${ELEMENTS[raw.type]}> can't go in a <${where}>.`);
  };

  const convertMore = (raw: Raw): VisualMore => {
    counted(raw);
    checkAttrs(raw);
    const parts: VisualMore['parts'] = [];
    let length = 0;
    for (const c of raw.children) {
      if ('text' in c) {
        const t = c.text.replace(/\s+/g, ' ').trim();
        if (t) {
          parts.push({ type: 'text', text: t });
          length += t.length;
        }
      } else if ('type' in c) {
        if (c.type === 'code') parts.push(convertCode(c, false));
        else err(c.line, `<More> holds text and <Code> only; <${ELEMENTS[c.type]}> can't go in it.`);
      }
    }
    if (length > VISUAL_LIMITS.more) err(raw.line, `The text in <More> is ${length} characters; keep it under ${VISUAL_LIMITS.more}.`);
    if (parts.length === 0) err(raw.line, '<More> is empty.');
    return { parts };
  };
  /** The one <More> of a Card or Item, if any. */
  const moreOf = (raw: Raw): VisualMore | undefined => {
    const mores = elementsOf(raw).filter((c) => c.type === 'more');
    if (mores.length > 1) err(mores[1].line, `<${ELEMENTS[raw.type]}> from line ${raw.line} has more than one <More>; use one.`);
    return mores.length ? convertMore(mores[0]) : undefined;
  };

  const convertCode = (raw: Raw, incoming: boolean): VisualCode => {
    counted(raw);
    checkAttrs(raw);
    const body = raw.children.find((c): c is RawCode => 'raw' in c);
    const code = body ? dedent(body.raw) : '';
    if (!code.trim()) err(raw.line, '<Code> is empty; put the code between <Code> and </Code>.');
    const lines = code.split('\n').length;
    if (lines > VISUAL_LIMITS.codeLines) err(raw.line, `<Code> has ${lines} lines; show at most ${VISUAL_LIMITS.codeLines} (the lines that matter).`);
    const fileAttr = str(raw, 'file');
    const file = fileAttr?.replace(/^file:/, '').trim() || undefined;
    let start: number | undefined;
    const lineAttr = str(raw, 'line');
    if (lineAttr !== undefined) {
      if (/^\d+$/.test(lineAttr) && Number(lineAttr) > 0) start = Number(lineAttr);
      else err(raw.attrs.get('line')!.line, `line="${lineAttr}" must be the file's line number of the first line, like line="40".`);
      if (!file) warn(raw.attrs.get('line')!.line, 'line numbers the code, but without file="…" the user can\'t open it.');
    }
    let mark: number[] = [];
    const markAttr = str(raw, 'mark');
    if (markAttr !== undefined) {
      const parsed = parseMark(markAttr);
      if (!parsed) err(raw.attrs.get('mark')!.line, `mark="${markAttr}" must be line numbers like "42", "42-44" or "40, 43".`);
      else {
        const first = start ?? 1;
        const outside = parsed.filter((n) => n < first || n >= first + lines);
        if (outside.length) {
          warn(raw.attrs.get('mark')!.line, `mark ${outside.join(', ')} is outside the code (lines ${first}–${first + lines - 1}); mark uses the file's line numbers when line is set, else 1 is the first line.`);
        }
        mark = parsed.filter((n) => !outside.includes(n));
      }
    }
    for (const c of elementsOf(raw)) err(c.line, `<Code> can't hold other elements.`);
    return { type: 'code', code, lang: str(raw, 'lang'), file, start, mark, arrow: arrowOf(raw, incoming), line: raw.line };
  };

  const convertItem = (raw: Raw, depth: number, inTimeline: boolean): VisualItem => {
    counted(raw);
    checkAttrs(raw);
    if (depth === VISUAL_LIMITS.treeDepth + 1) err(raw.line, `The tree is more than ${VISUAL_LIMITS.treeDepth} levels deep; flatten it.`);
    const title = str(raw, 'title', VISUAL_LIMITS.title);
    if (!title) err(raw.line, '<Item> needs a title="…".');
    const when = str(raw, 'when', VISUAL_LIMITS.badge);
    if (when && !inTimeline) err(raw.attrs.get('when')!.line, 'when only works on an <Item> in a <Timeline>.');
    const collapsed = flag(raw, 'collapsed');
    if (raw.attrs.has('collapsed') && inTimeline) err(raw.attrs.get('collapsed')!.line, 'collapsed only works on an <Item> in a <Tree>.');
    const children: VisualItem[] = [];
    for (const c of elementsOf(raw)) {
      if (c.type === 'more') continue;
      if (c.type !== 'item') {
        misplaced(c, 'Item');
        continue;
      }
      if (inTimeline) {
        err(c.line, "A Timeline's items don't nest; put them one after another.");
        continue;
      }
      children.push(convertItem(c, depth + 1, false));
    }
    if (collapsed && children.length === 0 && !inTimeline) warn(raw.attrs.get('collapsed')!.line, 'collapsed has no effect on an item without children.');
    const more = moreOf(raw);
    if (more && children.length) err(raw.line, `<Item title="${title ?? ''}"> has children, so it folds; put the <More> on one of its children or in a note.`);
    return {
      type: 'item',
      title: title ?? '',
      icon: iconOf(raw),
      tone: toneOf(raw),
      // The note: text inside the tag, or note="…" (a common guess).
      text: bodyOf(raw, `"${title ?? 'an item'}"`, VISUAL_LIMITS.text) ?? str(raw, 'note', VISUAL_LIMITS.text),
      meta: str(raw, 'meta', VISUAL_LIMITS.badge),
      link: linkOf(raw),
      when,
      collapsed: collapsed && children.length > 0,
      more,
      children,
      line: raw.line,
    };
  };

  const progressOf = (raw: Raw): VisualCard['progress'] => {
    const v = str(raw, 'progress');
    if (v === undefined) return undefined;
    const frac = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(v);
    if (frac && Number(frac[2]) > 0) return { fraction: Math.min(1, Number(frac[1]) / Number(frac[2])), label: `${frac[1]}/${frac[2]}` };
    const pct = /^(\d+(?:\.\d+)?)\s*%?$/.exec(v);
    if (pct && Number(pct[1]) <= 100) return { fraction: Number(pct[1]) / 100, label: `${pct[1]}%` };
    err(raw.attrs.get('progress')!.line, `progress="${v}" must be a percentage like "60" or a count like "3/5".`);
    return undefined;
  };

  // `incoming`: an arrow leads into this element (it follows a sibling in an arrowed parent, or sits in a branch Row).
  const convert = (raw: Raw, depth: number, incoming: boolean): VisualNode | null => {
    if (raw.type === 'code') return convertCode(raw, incoming);
    counted(raw);
    if (depth === VISUAL_LIMITS.depth + 1) err(raw.line, `Nested more than ${VISUAL_LIMITS.depth} levels deep; flatten it.`);
    checkAttrs(raw);
    const tag = ELEMENTS[raw.type];
    const elements = elementsOf(raw);
    const texts = textsOf(raw);

    switch (raw.type) {
      case 'card': {
        const title = str(raw, 'title', VISUAL_LIMITS.title);
        if (!title) err(raw.line, '<Card> needs a title="…".');
        const value = str(raw, 'value', VISUAL_LIMITS.value);
        const change = str(raw, 'change', VISUAL_LIMITS.value);
        if (change && value === undefined) warn(raw.attrs.get('change')!.line, 'change sits next to a value; without value="…" it was dropped.');
        const children: VisualNode[] = [];
        for (const c of elements) {
          if (c.type === 'more') continue;
          if (!BLOCKS.has(c.type)) misplaced(c, 'Card');
          else {
            const node = convert(c, depth + 1, false);
            if (node) children.push(node);
          }
        }
        return {
          type: 'card',
          title: title ?? '',
          icon: iconOf(raw),
          text: bodyOf(raw, `"${title ?? 'a card'}"`, VISUAL_LIMITS.text),
          value,
          change: value !== undefined ? change : undefined,
          meta: str(raw, 'meta', VISUAL_LIMITS.badge),
          progress: progressOf(raw),
          tone: toneOf(raw),
          badge: str(raw, 'badge', VISUAL_LIMITS.badge),
          repo: str(raw, 'repo'),
          link: linkOf(raw),
          arrow: arrowOf(raw, incoming),
          more: moreOf(raw),
          children,
          line: raw.line,
        };
      }
      case 'tree':
      case 'timeline': {
        for (const t of texts) err(t.line, `Text "${t.text.trim().slice(0, 30)}" sits directly in <${tag}>; put it in an <Item>.`);
        const timeline = raw.type === 'timeline';
        const children: VisualItem[] = [];
        for (const c of elements) {
          if (c.type === 'item') children.push(convertItem(c, 1, timeline));
          else if (c.type === 'card') err(c.line, `A <${tag}> holds <Item>s, not Cards: <Item title="…">.`);
          else misplaced(c, tag);
        }
        if (children.length === 0) err(raw.line, `<${tag}> is empty; give it <Item>s.`);
        return { type: raw.type, arrow: arrowOf(raw, incoming), children, line: raw.line };
      }
      case 'bars': {
        for (const t of texts) err(t.line, `Text "${t.text.trim().slice(0, 30)}" sits directly in <Bars>; use <Bar label="…" value="…" />.`);
        const bars: VisualBar[] = [];
        for (const c of elements) {
          if (c.type !== 'bar') {
            err(c.line, `<Bars> holds <Bar> elements only, not <${ELEMENTS[c.type]}>.`);
            continue;
          }
          counted(c);
          checkAttrs(c);
          for (const e of elementsOf(c)) err(e.line, '<Bar> holds nothing; write <Bar label="…" value="…" />.');
          const label = str(c, 'label', VISUAL_LIMITS.title);
          if (!label) err(c.line, '<Bar> needs a label="…".');
          const shown = str(c, 'value', VISUAL_LIMITS.value);
          const value = shown !== undefined ? Number(shown.replace(/[,_\s]/g, '')) : NaN;
          if (shown === undefined) err(c.line, '<Bar> needs a value="…", a number.');
          else if (!Number.isFinite(value) || value < 0) err(c.attrs.get('value')!.line, `value="${shown}" must be a number of 0 or more; put the unit on <Bars unit="…">.`);
          bars.push({ label: label ?? '', value: Number.isFinite(value) ? Math.max(0, value) : 0, shown: shown ?? '', tone: toneOf(c), line: c.line });
        }
        if (bars.length === 0) err(raw.line, '<Bars> is empty; give it <Bar label="…" value="…" /> elements.');
        if (bars.length > VISUAL_LIMITS.bars) err(raw.line, `<Bars> has ${bars.length} bars; keep it to ${VISUAL_LIMITS.bars}, or use a Mermaid xychart.`);
        return { type: 'bars', title: str(raw, 'title', VISUAL_LIMITS.title), unit: str(raw, 'unit', VISUAL_LIMITS.badge), arrow: arrowOf(raw, incoming), bars, line: raw.line };
      }
      case 'image': {
        for (const c of [...elements, ...texts]) err(c.line, '<Image> holds nothing; write <Image src="file:…" caption="…" />.');
        const src = str(raw, 'src');
        if (!src) err(raw.line, '<Image> needs src="file:<path>".');
        else if (!src.startsWith('file:')) err(raw.attrs.get('src')!.line, `src="${src}" must be file:<path>, an image in your folder.`);
        else if (!IMAGE_EXT.test(src)) err(raw.attrs.get('src')!.line, `src="${src}" is not an image (png, jpg, gif, webp, svg).`);
        return { type: 'image', src: src ?? '', caption: str(raw, 'caption', VISUAL_LIMITS.text), arrow: arrowOf(raw, incoming), line: raw.line };
      }
      default: {
        // row / column
        const container = raw.type as 'row' | 'column';
        for (const t of texts) err(t.line, `Text "${t.text.trim().slice(0, 30)}" sits directly in <${tag}>; put it in a Card.`);
        const arrows = flag(raw, 'arrows');
        if (elements.length === 0) err(raw.line, `<${tag}> is empty.`);
        if (container === 'row' && elements.length > VISUAL_LIMITS.rowChildren) {
          warn(raw.line, `<Row> has ${elements.length} children; more than ${VISUAL_LIMITS.rowChildren} wrap onto a second line.`);
        }
        // A plain Row that follows a sibling in an arrowed Column is a branch: each child gets its own arrow.
        const branch = container === 'row' && !arrows && incoming;
        const children: VisualNode[] = [];
        elements.forEach((c, i) => {
          if (!BLOCKS.has(c.type)) return misplaced(c, tag);
          const node = convert(c, depth + 1, branch || (arrows && i > 0));
          if (node) children.push(node);
        });
        return { type: container, arrows, arrow: arrowOf(raw, incoming), children, line: raw.line };
      }
    }
  };

  for (const t of top.children) if ('text' in t) err(t.line, `Text "${t.text.trim().slice(0, 30)}" is outside any element; put it in a Card.`);
  const nodes: VisualNode[] = [];
  for (const c of top.children) {
    if (!('type' in c)) continue;
    if (!BLOCKS.has(c.type)) {
      misplaced(c, 'top level');
      continue;
    }
    const node = convert(c, 1, false);
    if (node) nodes.push(node);
  }
  if (nodes.length === 0 && errors.length === 0) err(1, 'The markup has no elements.');
  errors.sort((a, b) => a.line - b.line);
  warnings.sort((a, b) => a.line - b.line);
  return { nodes, errors, warnings };
}

function elementType(name: string): ElementType | null {
  const n = name.toLowerCase();
  return n in ELEMENTS ? (n as ElementType) : null;
}

/** Every node, items and the code in More included, depth first. */
export function walkVisual(nodes: VisualNode[], fn: (n: VisualNode | VisualItem) => void): void {
  const visit = (n: VisualNode | VisualItem) => {
    fn(n);
    if (n.type === 'row' || n.type === 'column' || n.type === 'card' || n.type === 'tree' || n.type === 'timeline' || n.type === 'item') {
      (n.children as (VisualNode | VisualItem)[]).forEach(visit);
    }
    if ((n.type === 'card' || n.type === 'item') && n.more) for (const p of n.more.parts) if (p.type === 'code') visit(p);
  };
  nodes.forEach(visit);
}

export function formatIssues(issues: VisualIssue[]): string {
  return issues.map((i) => `line ${i.line}: ${i.message}`).join('\n');
}
