/**
 * Visual markup: the small JSX-like language agents use with `show_visual` (docs/visuals-research.md).
 * Three elements (Row, Column, Card), string attributes and flags, text inside cards. It is parsed into a
 * tree and drawn by the UI's own components; nothing is ever run or inserted as HTML. Used by the tool (to
 * return errors to the agent) and by the UI (to draw it), so this module has no Node or DOM dependencies.
 */

/** Lucide icon names (kebab case) an agent may use. The UI maps each to its component. */
export const VISUAL_ICONS = [
  'check', 'x', 'circle-check', 'circle-x', 'circle-alert', 'triangle-alert', 'info', 'circle-help', 'ban',
  'clock', 'hourglass', 'loader', 'star', 'flag', 'lightbulb', 'target', 'zap', 'sparkles',
  'code', 'terminal', 'bug', 'git-branch', 'git-merge', 'git-pull-request', 'git-commit-horizontal', 'package',
  'box', 'boxes', 'puzzle', 'wrench', 'settings', 'flask-conical', 'file', 'file-text', 'file-code', 'file-diff',
  'folder', 'database', 'server', 'cloud', 'globe', 'network', 'plug', 'cpu', 'layers', 'layout-template',
  'workflow', 'list-checks', 'list', 'table', 'chart-column', 'chart-line', 'gauge',
  'user', 'users', 'bot', 'brain', 'message-square', 'mail', 'bell', 'eye', 'search',
  'key-round', 'lock', 'lock-open', 'shield', 'shield-check',
  'arrow-right', 'repeat', 'refresh-cw', 'split', 'merge', 'play', 'pause', 'rocket', 'timer',
  'hard-drive', 'monitor', 'smartphone', 'calendar', 'link', 'download', 'upload', 'trash-2', 'pencil', 'plus',
  'minus', 'tag', 'scale', 'trending-up', 'trending-down', 'coins',
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

export type VisualCard = {
  type: 'card';
  title: string;
  icon?: VisualIcon;
  /** Body text: plain text, `code` spans allowed. */
  text?: string;
  /** A key number; the title is its label. */
  value?: string;
  tone?: VisualTone;
  badge?: string;
  repo?: string;
  /** `expert:<name>`, `file:<path>` or an http(s) URL. */
  link?: string;
  arrow?: string;
  children: VisualNode[];
  line: number;
};

export type VisualNode = VisualContainer | VisualCard;

export type VisualIssue = { line: number; message: string };

export type VisualParse = {
  nodes: VisualNode[];
  /** Any error means the visual is not shown. */
  errors: VisualIssue[];
  /** Shown anyway; the agent hears about them. */
  warnings: VisualIssue[];
};

export const VISUAL_LIMITS = { depth: 4, elements: 40, rowChildren: 4, title: 60, text: 300, badge: 24, value: 16, arrow: 30 };

const ELEMENTS = { row: 'Row', column: 'Column', card: 'Card' } as const;
type ElementType = keyof typeof ELEMENTS;

const CONTAINER_ATTRS = ['arrows', 'arrow'];
const CARD_ATTRS = ['title', 'icon', 'tone', 'badge', 'value', 'repo', 'link', 'arrow'];
const MAX_ISSUES = 12;

type Attr = { value: string | true; line: number };
type Raw = { type: ElementType; attrs: Map<string, Attr>; children: (Raw | { text: string; line: number })[]; line: number };

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
      if (!type) err(line, `<${name}> is not an element; use Row, Column or Card.`);

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
  // `incoming`: an arrow leads into this element (it follows a sibling in an arrowed parent, or sits in a branch Row).
  const convert = (raw: Raw, depth: number, incoming: boolean): VisualNode | null => {
    count++;
    if (count === VISUAL_LIMITS.elements + 1) err(raw.line, `More than ${VISUAL_LIMITS.elements} elements; keep a visual small and split it, or use Mermaid.`);
    if (depth === VISUAL_LIMITS.depth + 1) err(raw.line, `Nested more than ${VISUAL_LIMITS.depth} levels deep; flatten it.`);
    const tag = ELEMENTS[raw.type];
    const allowed = raw.type === 'card' ? CARD_ATTRS : CONTAINER_ATTRS;
    for (const [key, a] of raw.attrs) {
      if (!allowed.includes(key)) err(a.line, `<${tag}> has no attribute ${key}; it takes ${allowed.join(', ')}.`);
    }
    const str = (key: string, max?: number): string | undefined => {
      const a = raw.attrs.get(key);
      if (!a) return undefined;
      if (a.value === true) {
        err(a.line, `${key} needs a value: ${key}="…".`);
        return undefined;
      }
      const v = a.value.replace(/\s+/g, ' ').trim();
      if (!v) return undefined;
      if (max && v.length > max) err(a.line, `${key} is ${v.length} characters; keep it under ${max}.`);
      return v;
    };
    const arrow = str('arrow', VISUAL_LIMITS.arrow);
    if (arrow && !incoming) {
      warn(
        raw.attrs.get('arrow')!.line,
        `arrow="${arrow}" was dropped: no arrow leads into this element. arrow labels the arrow coming in from the previous sibling, so the first child of an arrowed Column or Row has none, and the parent needs the arrows flag.`,
      );
    }

    const elements = raw.children.filter((c): c is Raw => 'type' in c);
    const texts = raw.children.filter((c): c is { text: string; line: number } => 'text' in c);

    if (raw.type === 'card') {
      const title = str('title', VISUAL_LIMITS.title);
      if (!title) err(raw.line, '<Card> needs a title="…".');
      const iconName = str('icon');
      let icon: VisualIcon | undefined;
      if (iconName) {
        if ((VISUAL_ICONS as readonly string[]).includes(iconName)) icon = iconName as VisualIcon;
        else err(raw.attrs.get('icon')!.line, `icon "${iconName}" is not in the icon list.`);
      }
      const toneName = str('tone');
      let tone: VisualTone | undefined;
      if (toneName) {
        if ((VISUAL_TONES as readonly string[]).includes(toneName)) tone = toneName as VisualTone;
        else err(raw.attrs.get('tone')!.line, `tone "${toneName}" is unknown; use ${VISUAL_TONES.join(', ')}.`);
      }
      const link = str('link');
      if (link && !/^(expert:.+|file:.+|https?:\/\/\S+)$/.test(link)) {
        err(raw.attrs.get('link')!.line, `link "${link}" must be expert:<name>, file:<path> or an http(s) URL.`);
      }
      const body = texts.map((t) => t.text).join(' ').replace(/\s+/g, ' ').trim();
      if (body.length > VISUAL_LIMITS.text) err(texts[0].line, `The text of "${title ?? 'a card'}" is ${body.length} characters; keep it under ${VISUAL_LIMITS.text}.`);
      const children = elements.map((c) => convert(c, depth + 1, false)).filter((c): c is VisualNode => c !== null);
      return {
        type: 'card',
        title: title ?? '',
        icon,
        text: body || undefined,
        value: str('value', VISUAL_LIMITS.value),
        tone,
        badge: str('badge', VISUAL_LIMITS.badge),
        repo: str('repo'),
        link,
        arrow,
        children,
        line: raw.line,
      };
    }

    for (const t of texts) err(t.line, `Text "${t.text.trim().slice(0, 30)}" sits directly in <${tag}>; put it in a Card.`);
    const flag = raw.attrs.get('arrows');
    const arrows = flag !== undefined && flag.value !== 'false';
    if (flag && flag.value !== true && flag.value !== 'false' && flag.value !== 'true') err(flag.line, 'arrows is a flag: write <Column arrows>.');
    if (elements.length === 0) err(raw.line, `<${tag}> is empty.`);
    if (raw.type === 'row' && elements.length > VISUAL_LIMITS.rowChildren) {
      warn(raw.line, `<Row> has ${elements.length} children; more than ${VISUAL_LIMITS.rowChildren} wrap onto a second line.`);
    }
    // A plain Row that follows a sibling in an arrowed Column is a branch: each child gets its own arrow.
    const branch = raw.type === 'row' && !arrows && incoming;
    const children = elements
      .map((c, i) => convert(c, depth + 1, branch || (arrows && i > 0)))
      .filter((c): c is VisualNode => c !== null);
    return { type: raw.type, arrows, arrow, children, line: raw.line };
  };

  for (const t of top.children) if ('text' in t) err(t.line, `Text "${t.text.trim().slice(0, 30)}" is outside any element; put it in a Card.`);
  const nodes = top.children
    .filter((c): c is Raw => 'type' in c)
    .map((c) => convert(c, 1, false))
    .filter((c): c is VisualNode => c !== null);
  if (nodes.length === 0 && errors.length === 0) err(1, 'The markup has no elements.');
  errors.sort((a, b) => a.line - b.line);
  warnings.sort((a, b) => a.line - b.line);
  return { nodes, errors, warnings };
}

function elementType(name: string): ElementType | null {
  const n = name.toLowerCase();
  return n === 'row' || n === 'column' || n === 'card' ? n : null;
}

/** Every card, depth first. */
export function visualCards(nodes: VisualNode[]): VisualCard[] {
  const out: VisualCard[] = [];
  const walk = (n: VisualNode) => {
    if (n.type === 'card') out.push(n);
    n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

export function formatIssues(issues: VisualIssue[]): string {
  return issues.map((i) => `line ${i.line}: ${i.message}`).join('\n');
}
