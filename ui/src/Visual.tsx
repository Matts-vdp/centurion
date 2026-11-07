import { Fragment, useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  Check as LucideCheck,
  X as LucideX,
  CircleCheck as LucideCircleCheck,
  CircleX as LucideCircleX,
  CircleAlert as LucideCircleAlert,
  TriangleAlert as LucideTriangleAlert,
  Info as LucideInfo,
  CircleHelp as LucideCircleHelp,
  Ban as LucideBan,
  Clock as LucideClock,
  Hourglass as LucideHourglass,
  Loader as LucideLoader,
  Star as LucideStar,
  Flag as LucideFlag,
  Lightbulb as LucideLightbulb,
  Target as LucideTarget,
  Zap as LucideZap,
  Sparkles as LucideSparkles,
  Code as LucideCode,
  Terminal as LucideTerminal,
  Bug as LucideBug,
  GitBranch as LucideGitBranch,
  GitMerge as LucideGitMerge,
  GitPullRequest as LucideGitPullRequest,
  GitCommitHorizontal as LucideGitCommitHorizontal,
  Package as LucidePackage,
  Box as LucideBox,
  Boxes as LucideBoxes,
  Puzzle as LucidePuzzle,
  Wrench as LucideWrench,
  Settings as LucideSettings,
  FlaskConical as LucideFlaskConical,
  File as LucideFile,
  FileText as LucideFileText,
  FileCode as LucideFileCode,
  FileDiff as LucideFileDiff,
  Folder as LucideFolder,
  Database as LucideDatabase,
  Server as LucideServer,
  Cloud as LucideCloud,
  Globe as LucideGlobe,
  Network as LucideNetwork,
  Plug as LucidePlug,
  Cpu as LucideCpu,
  Layers as LucideLayers,
  LayoutTemplate as LucideLayoutTemplate,
  Workflow as LucideWorkflow,
  ListChecks as LucideListChecks,
  List as LucideList,
  Table as LucideTable,
  ChartColumn as LucideChartColumn,
  ChartLine as LucideChartLine,
  Gauge as LucideGauge,
  User as LucideUser,
  Users as LucideUsers,
  Bot as LucideBot,
  Brain as LucideBrain,
  MessageSquare as LucideMessageSquare,
  Mail as LucideMail,
  Bell as LucideBell,
  Eye as LucideEye,
  Search as LucideSearch,
  KeyRound as LucideKeyRound,
  Lock as LucideLock,
  LockOpen as LucideLockOpen,
  Shield as LucideShield,
  ShieldCheck as LucideShieldCheck,
  ArrowRight as LucideArrowRight,
  Repeat as LucideRepeat,
  RefreshCw as LucideRefreshCw,
  Split as LucideSplit,
  Merge as LucideMerge,
  Play as LucidePlay,
  Pause as LucidePause,
  Rocket as LucideRocket,
  Timer as LucideTimer,
  HardDrive as LucideHardDrive,
  Monitor as LucideMonitor,
  Smartphone as LucideSmartphone,
  Calendar as LucideCalendar,
  Link as LucideLink,
  Download as LucideDownload,
  Upload as LucideUpload,
  Trash2 as LucideTrash2,
  Pencil as LucidePencil,
  Plus as LucidePlus,
  Minus as LucideMinus,
  Tag as LucideTag,
  Scale as LucideScale,
  TrendingUp as LucideTrendingUp,
  TrendingDown as LucideTrendingDown,
  Coins as LucideCoins,
  CircleDot as LucideCircleDot,
  CircleSlash as LucideCircleSlash,
  History as LucideHistory,
  SquareFunction as LucideSquareFunction,
  GitCompare as LucideGitCompare,
  FileJson as LucideFileJson,
  FolderOpen as LucideFolderOpen,
  Image as LucideImage,
  Route as LucideRoute,
  ListTree as LucideListTree,
  type LucideIcon,
} from 'lucide-react';
import type { AgentRecord } from './api';
import { baseName, fileLinks, filesApi, joinPath, locate, type Root } from './fileStore';
import { highlight, language, languageOf } from './highlight';
import { Chevron, FileCodeIcon, OpenIcon } from './icons';
import { nameHue } from './status';
import {
  parseVisual,
  splitFileLink,
  type VisualBars,
  type VisualCard,
  type VisualCode,
  type VisualContainer,
  type VisualIcon,
  type VisualImage,
  type VisualItem,
  type VisualMore,
  type VisualNode,
  type VisualTimeline,
  type VisualTone,
  type VisualTree,
} from '../../src/visual';

/** The icons visual markup may name (`VISUAL_ICONS` in src/visual.ts); the type keeps the two lists equal. */
const ICONS: Record<VisualIcon, LucideIcon> = {
  check: LucideCheck,
  x: LucideX,
  'circle-check': LucideCircleCheck,
  'circle-x': LucideCircleX,
  'circle-alert': LucideCircleAlert,
  'triangle-alert': LucideTriangleAlert,
  info: LucideInfo,
  'circle-help': LucideCircleHelp,
  ban: LucideBan,
  clock: LucideClock,
  hourglass: LucideHourglass,
  loader: LucideLoader,
  star: LucideStar,
  flag: LucideFlag,
  lightbulb: LucideLightbulb,
  target: LucideTarget,
  zap: LucideZap,
  sparkles: LucideSparkles,
  code: LucideCode,
  terminal: LucideTerminal,
  bug: LucideBug,
  'git-branch': LucideGitBranch,
  'git-merge': LucideGitMerge,
  'git-pull-request': LucideGitPullRequest,
  'git-commit-horizontal': LucideGitCommitHorizontal,
  package: LucidePackage,
  box: LucideBox,
  boxes: LucideBoxes,
  puzzle: LucidePuzzle,
  wrench: LucideWrench,
  settings: LucideSettings,
  'flask-conical': LucideFlaskConical,
  file: LucideFile,
  'file-text': LucideFileText,
  'file-code': LucideFileCode,
  'file-diff': LucideFileDiff,
  folder: LucideFolder,
  database: LucideDatabase,
  server: LucideServer,
  cloud: LucideCloud,
  globe: LucideGlobe,
  network: LucideNetwork,
  plug: LucidePlug,
  cpu: LucideCpu,
  layers: LucideLayers,
  'layout-template': LucideLayoutTemplate,
  workflow: LucideWorkflow,
  'list-checks': LucideListChecks,
  list: LucideList,
  table: LucideTable,
  'chart-column': LucideChartColumn,
  'chart-line': LucideChartLine,
  gauge: LucideGauge,
  user: LucideUser,
  users: LucideUsers,
  bot: LucideBot,
  brain: LucideBrain,
  'message-square': LucideMessageSquare,
  mail: LucideMail,
  bell: LucideBell,
  eye: LucideEye,
  search: LucideSearch,
  'key-round': LucideKeyRound,
  lock: LucideLock,
  'lock-open': LucideLockOpen,
  shield: LucideShield,
  'shield-check': LucideShieldCheck,
  'arrow-right': LucideArrowRight,
  repeat: LucideRepeat,
  'refresh-cw': LucideRefreshCw,
  split: LucideSplit,
  merge: LucideMerge,
  play: LucidePlay,
  pause: LucidePause,
  rocket: LucideRocket,
  timer: LucideTimer,
  'hard-drive': LucideHardDrive,
  monitor: LucideMonitor,
  smartphone: LucideSmartphone,
  calendar: LucideCalendar,
  link: LucideLink,
  download: LucideDownload,
  upload: LucideUpload,
  'trash-2': LucideTrash2,
  pencil: LucidePencil,
  plus: LucidePlus,
  minus: LucideMinus,
  tag: LucideTag,
  scale: LucideScale,
  'trending-up': LucideTrendingUp,
  'trending-down': LucideTrendingDown,
  coins: LucideCoins,
  'circle-dot': LucideCircleDot,
  'circle-slash': LucideCircleSlash,
  'history': LucideHistory,
  'square-function': LucideSquareFunction,
  'git-compare': LucideGitCompare,
  'file-json': LucideFileJson,
  'folder-open': LucideFolderOpen,
  'image': LucideImage,
  'route': LucideRoute,
  'list-tree': LucideListTree,
};

// ---------- the visual block ----------

type Ctx = {
  agent: AgentRecord;
  agents: Map<string, AgentRecord>;
  onSelect: (id: string) => void;
};

/** Icons that give a tone a shape, so state never rests on colour alone. */
const TONE_ICON: Partial<Record<VisualTone, VisualIcon>> = {
  ok: 'circle-check',
  bad: 'circle-x',
  warn: 'triangle-alert',
  running: 'loader',
};

/**
 * A show_visual call, drawn from its markup (docs/visuals-research.md). The look comes from the renderer:
 * cards that sit in a row or column get a hairline box, cards inside a card are rows without one, trees and
 * timelines are lines, and colour only comes from tone and repo.
 */
export function VisualView({ title, markup, ...ctx }: { title?: string; markup: string } & Ctx) {
  const parsed = useMemo(() => parseVisual(markup), [markup]);
  const [source, setSource] = useState(false);
  const broken = parsed.errors.length > 0;
  return (
    <figure className="visual">
      <figcaption className="visual-head">
        {title && <span className="visual-title">{title}</span>}
        {!broken && (
          <button className="visual-toggle" aria-pressed={source} onClick={() => setSource((s) => !s)}>
            {source ? 'Visual' : 'Source'}
          </button>
        )}
      </figcaption>
      {broken && <div className="visual-broken">This visual could not be drawn; here is its source.</div>}
      {source || broken ? (
        <pre className="code-plain visual-source">{markup}</pre>
      ) : (
        <div className="visual-body">
          {parsed.nodes.map((n, i) => (
            <NodeView key={i} node={n} inCard={false} ctx={ctx} />
          ))}
        </div>
      )}
    </figure>
  );
}

function NodeView({ node, inCard, ctx }: { node: VisualNode; inCard: boolean; ctx: Ctx }) {
  switch (node.type) {
    case 'card':
      return <CardView card={node} inCard={inCard} ctx={ctx} />;
    case 'column':
      return <ColumnView column={node} inCard={inCard} ctx={ctx} />;
    case 'row':
      return <RowView row={node} inCard={inCard} ctx={ctx} />;
    case 'tree':
      return <TreeView tree={node} inCard={inCard} ctx={ctx} />;
    case 'timeline':
      return <TimelineView timeline={node} ctx={ctx} />;
    case 'bars':
      return <BarsView bars={node} />;
    case 'image':
      return <ImageView image={node} ctx={ctx} />;
    case 'code':
      return <CodeView code={node} ctx={ctx} />;
  }
}

function ColumnView({ column, inCard, ctx }: { column: VisualContainer; inCard: boolean; ctx: Ctx }) {
  return (
    <div className={`v-column${column.arrows ? ' arrows' : ''}${inCard ? ' in-card' : ''}`}>
      {column.children.map((c, i) => {
        // A plain Row after a sibling in an arrowed Column is a branch: the arrow fans out to each child.
        const branch = column.arrows && i > 0 && c.type === 'row' && !c.arrows;
        return (
          <Fragment key={i}>
            {column.arrows && i > 0 && (branch ? <div className="v-stem" aria-hidden="true" /> : <Arrow dir="down" label={c.arrow} />)}
            {branch ? <BranchView row={c as VisualContainer} inCard={inCard} ctx={ctx} /> : <NodeView node={c} inCard={inCard} ctx={ctx} />}
          </Fragment>
        );
      })}
    </div>
  );
}

function BranchView({ row, inCard, ctx }: { row: VisualContainer; inCard: boolean; ctx: Ctx }) {
  return (
    <div className="v-branch">
      {row.children.map((c, i) => (
        <div className="v-branch-cell" key={i}>
          <Arrow dir="down" label={c.arrow} />
          <NodeView node={c} inCard={inCard} ctx={ctx} />
        </div>
      ))}
    </div>
  );
}

function RowView({ row, inCard, ctx }: { row: VisualContainer; inCard: boolean; ctx: Ctx }) {
  if (!row.arrows) {
    return (
      <div className={`v-row${inCard ? ' in-card' : ''}`}>
        {row.children.map((c, i) => (
          <NodeView key={i} node={c} inCard={inCard} ctx={ctx} />
        ))}
      </div>
    );
  }
  return (
    <div className={`v-flow-row${inCard ? ' in-card' : ''}`}>
      {row.children.map((c, i) => (
        <Fragment key={i}>
          {i > 0 && <Arrow dir="right" label={c.arrow} />}
          <div className="v-flow-cell">
            <NodeView node={c} inCard={inCard} ctx={ctx} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

/** A connector with an optional label. Right-pointing arrows turn down when the visual is narrow. */
function Arrow({ dir, label }: { dir: 'down' | 'right'; label?: string }) {
  return (
    <div className={`v-arrow ${dir}${label ? ' labelled' : ''}`}>
      {label && (
        <span className="v-arrow-label" title={label}>
          {label}
        </span>
      )}
      <span className="v-arrow-shaft" aria-hidden="true">
        <svg className="v-arrow-head" viewBox="0 0 10 6" width="10" height="6">
          <path d="M1 1l4 4 4-4" />
        </svg>
      </span>
    </div>
  );
}

/** Click and Enter / Space on something that isn't a button. */
function pressable(onPress: () => void, expanded?: boolean) {
  return {
    role: 'button',
    tabIndex: 0,
    'aria-expanded': expanded,
    onClick: onPress,
    onKeyDown: (e: ReactKeyboardEvent) => {
      if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      onPress();
    },
  };
}

function toneIcon(icon: VisualIcon | undefined, tone: VisualTone | undefined): LucideIcon | null {
  const name = icon ?? (tone ? TONE_ICON[tone] : undefined);
  return name ? ICONS[name] : null;
}

function CardView({ card, inCard, ctx }: { card: VisualCard; inCard: boolean; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  const Icon = toneIcon(card.icon, card.tone);
  const icon = Icon ? <Icon className="v-icon" size={16} aria-hidden="true" /> : null;
  const meta = card.meta ?? card.progress?.label;
  const head = (
    <div className={`v-head${card.more ? ' expandable' : ''}`} {...(card.more ? pressable(() => setOpen((o) => !o), open) : {})}>
      {icon}
      <LinkedTitle card={card} ctx={ctx} />
      {card.repo && (
        <span className="v-repo repo-hue" data-hue={nameHue(card.repo)}>
          {card.repo}
        </span>
      )}
      {(meta || card.badge || card.more) && (
        // Wraps as one piece under a long title, and stays on the right.
        <span className="v-head-end">
          {meta && <span className="v-meta">{meta}</span>}
          {card.badge && <span className="v-badge">{card.badge}</span>}
          {card.more && <Chevron open={open} className="v-chevron" size={14} />}
        </span>
      )}
    </div>
  );
  // Inside a card, a one-line item stays a plain line; one with a body, children or a number is a sub-card on a tile.
  const tile = inCard && (card.text !== undefined || card.children.length > 0 || card.value !== undefined);
  const cls = `${inCard ? 'v-item' : 'v-card'}${tile ? ' v-tile' : ''}${card.tone ? ` tone-${card.tone}` : ''}${card.value !== undefined ? ' value' : ''}${icon ? ' has-icon' : ''}`;
  return (
    <div className={cls}>
      {card.value !== undefined && (
        <div className="v-value-line">
          <div className="v-value">{card.value}</div>
          {card.change && <span className="v-change">{card.change}</span>}
        </div>
      )}
      {head}
      {card.progress && (
        <div className="v-progress" role="progressbar" aria-valuenow={Math.round(card.progress.fraction * 100)} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ '--p': `${card.progress.fraction * 100}%` } as CSSProperties} />
        </div>
      )}
      {card.text && (
        <p className="v-text">
          <Inline text={card.text} />
        </p>
      )}
      {card.children.length > 0 && (
        <div className="v-children">
          {card.children.map((c, i) => (
            <NodeView key={i} node={c} inCard ctx={ctx} />
          ))}
        </div>
      )}
      {card.more && open && <MoreView more={card.more} ctx={ctx} />}
    </div>
  );
}

/** Collapsed details, once opened: text and code. */
function MoreView({ more, ctx }: { more: VisualMore; ctx: Ctx }) {
  return (
    <div className="v-more">
      {more.parts.map((p, i) =>
        p.type === 'text' ? (
          <p key={i}>
            <Inline text={p.text} />
          </p>
        ) : (
          <CodeView key={i} code={p} ctx={ctx} />
        ),
      )}
    </div>
  );
}

// ---------- links ----------

/** Where a link goes: a label for it, a tooltip, and how to follow it. */
type Target = { label: string; title: string; href?: string; open?: () => void };

function absolutePath(p: string, ctx: Ctx): string {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(p) ? p : joinPath(ctx.agent.cwd, p);
}

function fileTarget(p: string, line: number | undefined, ctx: Ctx): Target {
  const full = absolutePath(p, ctx);
  const name = baseName(p.replace(/\\/g, '/'));
  return {
    label: line ? `${name}:${line}` : name,
    title: `${full}${line ? `:${line}` : ''}\nOpen in the Files panel`,
    open: () => fileLinks.open({ agentId: ctx.agent.id, path: full, mode: 'file', line }),
  };
}

function linkTarget(link: string | undefined, ctx: Ctx): Target | null {
  if (!link) return null;
  if (/^https?:\/\//.test(link)) {
    let host = link;
    try {
      host = new URL(link).hostname;
    } catch {
      // keep the whole link
    }
    return { label: host, title: link, href: link };
  }
  if (link.startsWith('expert:')) {
    const target = findAgent(link.slice(7).trim(), ctx);
    return target ? { label: target.name, title: `Open ${target.name}`, open: () => ctx.onSelect(target.id) } : null;
  }
  if (link.startsWith('file:')) {
    const { path, line } = splitFileLink(link);
    return fileTarget(path, line, ctx);
  }
  return null;
}

function follow(t: Target): void {
  if (t.open) t.open();
  else if (t.href) window.open(t.href, '_blank', 'noopener,noreferrer');
}

/** A card's title, as a link when it has one the app can follow. */
function LinkedTitle({ card, ctx }: { card: VisualCard; ctx: Ctx }) {
  const label = <span className="v-title">{card.title}</span>;
  const t = linkTarget(card.link, ctx);
  if (!t) return label;
  if (t.href) {
    return (
      <a className="v-link" href={t.href} target="_blank" rel="noreferrer" title={t.title} onClick={(e) => e.stopPropagation()}>
        {label}
        <OpenIcon size={12} aria-hidden="true" />
      </a>
    );
  }
  return (
    <button
      className="v-link"
      title={t.title}
      onClick={(e) => {
        e.stopPropagation();
        follow(t);
      }}
    >
      {label}
      <OpenIcon size={12} aria-hidden="true" />
    </button>
  );
}

/** The quiet link on the right of a tree or timeline line: a location like logout.ts:40, or an icon. */
function LinkChip({ target, label }: { target: Target; label?: string }) {
  return (
    <button
      className="v-loc"
      title={target.title}
      aria-label={label ? undefined : target.title.split('\n')[0]}
      onClick={(e) => {
        e.stopPropagation();
        follow(target);
      }}
    >
      {label ?? <OpenIcon size={12} aria-hidden="true" />}
    </button>
  );
}

/** An agent in the same chat (the chat itself or one of its experts), by id or name. */
function findAgent(nameOrId: string, ctx: Ctx): AgentRecord | null {
  const rootId = ctx.agent.parentId ?? ctx.agent.id;
  const wanted = nameOrId.toLowerCase();
  for (const a of ctx.agents.values()) {
    if (a.id !== rootId && a.parentId !== rootId) continue;
    if (a.id.toLowerCase() === wanted || a.name.toLowerCase() === wanted) return a;
  }
  return null;
}

// ---------- trees and timelines ----------

const countItems = (it: VisualItem): number => it.children.reduce((n, c) => n + 1 + countItems(c), 0);

function TreeView({ tree, inCard, ctx }: { tree: VisualTree; inCard: boolean; ctx: Ctx }) {
  return (
    <div className={`v-tree${inCard ? '' : ' boxed'}`} role="tree">
      {tree.children.map((it, i) => (
        <TreeItem key={i} item={it} depth={0} ctx={ctx} />
      ))}
    </div>
  );
}

/**
 * A line of a tree. Items with children fold; a leaf with <More> opens its details; a leaf with a link opens it
 * when clicked. The location of a link shows on the right unless the title already names the file.
 */
function TreeItem({ item, depth, ctx }: { item: VisualItem; depth: number; ctx: Ctx }) {
  const kids = item.children.length > 0;
  const [open, setOpen] = useState(!item.collapsed);
  const [moreOpen, setMoreOpen] = useState(false);
  const target = linkTarget(item.link, ctx);
  const folds = kids || item.more !== undefined;
  const isOpen = kids ? open : moreOpen;
  const opensLink = !folds && target !== null;
  const showLabel = target !== null && target.label !== item.title;
  const Icon = toneIcon(item.icon, item.tone);
  const hidden = kids && !open ? countItems(item) : 0;
  const press = folds ? () => (kids ? setOpen((o) => !o) : setMoreOpen((o) => !o)) : opensLink ? () => follow(target!) : null;
  return (
    <div className={`v-tree-node${item.tone ? ` tone-${item.tone}` : ''}`} role="treeitem" aria-expanded={kids ? open : undefined}>
      <div
        className={`v-tree-row${press ? ' pressable' : ''}`}
        style={{ '--d': depth } as CSSProperties}
        title={opensLink ? target!.title : undefined}
        {...(press ? pressable(press, folds ? isOpen : undefined) : {})}
      >
        {folds ? <Chevron open={isOpen} className="v-tree-chevron" size={14} /> : <span className="v-tree-space" />}
        {Icon ? <Icon className="v-icon" size={15} aria-hidden="true" /> : <span className="v-tree-noicon" />}
        <span className="v-tree-title">
          <Inline text={item.title} />
        </span>
        <span className="v-tree-note" title={item.text}>
          {item.text && <Inline text={item.text} />}
          {hidden > 0 && (
            <span className="v-tree-hidden">
              {item.text ? ' · ' : ''}
              {hidden} item{hidden === 1 ? '' : 's'}
            </span>
          )}
        </span>
        {item.meta && <span className="v-meta">{item.meta}</span>}
        {target && (showLabel || folds) && <LinkChip target={target} label={showLabel ? target.label : undefined} />}
      </div>
      {item.more && moreOpen && (
        <div className="v-tree-more" style={{ '--d': depth } as CSSProperties}>
          <MoreView more={item.more} ctx={ctx} />
        </div>
      )}
      {kids && open && (
        <div role="group">
          {item.children.map((c, i) => (
            <TreeItem key={i} item={c} depth={depth + 1} ctx={ctx} />
          ))}
        </div>
      )}
    </div>
  );
}

function TimelineView({ timeline, ctx }: { timeline: VisualTimeline; ctx: Ctx }) {
  // Items after the running one are still to come.
  const now = timeline.children.findIndex((it) => it.tone === 'running');
  const when = Math.max(0, ...timeline.children.map((it) => it.when?.length ?? 0));
  return (
    <div className={`v-timeline${when ? '' : ' no-when'}`} style={{ '--when': `${Math.min(when, 12) + 1}ch` } as CSSProperties}>
      {timeline.children.map((it, i) => (
        <TimelineItem key={i} item={it} later={now >= 0 && i > now} ctx={ctx} />
      ))}
    </div>
  );
}

function TimelineItem({ item, later, ctx }: { item: VisualItem; later: boolean; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  const target = linkTarget(item.link, ctx);
  return (
    <div className={`v-tl-item${item.tone ? ` tone-${item.tone}` : ''}${later ? ' later' : ''}`}>
      <span className="v-tl-when">{item.when}</span>
      <span className="v-tl-rail" aria-hidden="true">
        <span className="v-tl-dot" />
      </span>
      <div className="v-tl-body">
        <div className={`v-tl-head${item.more ? ' expandable' : ''}`} {...(item.more ? pressable(() => setOpen((o) => !o), open) : {})}>
          <span className="v-title">
            <Inline text={item.title} />
          </span>
          {item.meta && <span className="v-meta">{item.meta}</span>}
          {target && <LinkChip target={target} label={target.label} />}
          {item.more && <Chevron open={open} className="v-chevron" size={14} />}
        </div>
        {item.text && (
          <p className="v-text">
            <Inline text={item.text} />
          </p>
        )}
        {item.more && open && <MoreView more={item.more} ctx={ctx} />}
      </div>
    </div>
  );
}

// ---------- bars, images, code ----------

function BarsView({ bars }: { bars: VisualBars }) {
  const max = Math.max(0, ...bars.bars.map((b) => b.value)) || 1;
  const unit = !bars.title && bars.unit ? ` ${bars.unit}` : '';
  return (
    <div className="v-bars">
      {bars.title && (
        <div className="v-bars-title">
          {bars.title}
          {bars.unit && <span> {bars.unit}</span>}
        </div>
      )}
      {bars.bars.map((b, i) => (
        <Fragment key={i}>
          <span className="v-bar-label" title={b.label}>
            {b.label}
          </span>
          <div className={`v-bar${b.tone ? ` tone-${b.tone}` : ''}`} style={{ '--f': b.value / max } as CSSProperties}>
            <span className="v-bar-fill" />
            <span className="v-bar-value">
              {b.shown}
              {unit}
            </span>
          </div>
        </Fragment>
      ))}
    </div>
  );
}

/** Each agent's file roots, fetched once, to turn an image path into the Files API's raw URL. */
const rootsByAgent = new Map<string, Promise<Root[]>>();

function ImageView({ image, ctx }: { image: VisualImage; ctx: Ctx }) {
  const p = image.src.slice(5).trim();
  const full = absolutePath(p, ctx);
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let live = true;
    let roots = rootsByAgent.get(ctx.agent.id);
    if (!roots) {
      roots = filesApi.roots(ctx.agent.id).then((r) => r.roots);
      roots.catch(() => rootsByAgent.delete(ctx.agent.id));
      rootsByAgent.set(ctx.agent.id, roots);
    }
    roots.then(
      (r) => {
        if (!live) return;
        const at = locate(r, full);
        if (at) setUrl(filesApi.rawUrl(ctx.agent.id, at.root, at.path, 0));
        else setMissing(true);
      },
      () => live && setMissing(true),
    );
    return () => {
      live = false;
    };
  }, [ctx.agent.id, full]);
  const target = fileTarget(p, undefined, ctx);
  return (
    <figure className="v-image">
      {missing ? (
        <div className="v-image-missing">{p} can't be shown.</div>
      ) : (
        <button className="v-image-frame" title={target.title} onClick={() => follow(target)}>
          {url && <img src={url} alt={image.caption ?? baseName(p)} loading="lazy" onError={() => setMissing(true)} />}
        </button>
      )}
      {image.caption && <figcaption>{image.caption}</figcaption>}
    </figure>
  );
}

function CodeView({ code, ctx }: { code: VisualCode; ctx: Ctx }) {
  const diff = code.lang === 'diff';
  const lang = diff ? null : (language(code.lang) ?? (code.file ? languageOf(code.file) : null));
  const html = useMemo(() => highlight(code.code, lang), [code.code, lang]);
  const lines = code.code.split('\n');
  const first = code.start ?? 1;
  const numbers = code.start !== undefined && !diff;
  const marks = new Set(code.mark);
  // The header opens the file at the first marked line, else at the excerpt's first line.
  const target = code.file ? fileTarget(code.file, code.mark[0] ?? code.start, ctx) : null;
  return (
    <div className="v-code">
      {target && (
        <button className="v-code-head" title={target.title} onClick={() => follow(target)}>
          <FileCodeIcon size={14} aria-hidden="true" />
          <span>
            {baseName(code.file!.replace(/\\/g, '/'))}
            {code.start !== undefined && <span className="v-code-at">:{code.start}</span>}
          </span>
        </button>
      )}
      <div className="v-code-scroll">
        <div className="v-code-body">
          {lines.map((l, i) => {
            const cls = diff ? (l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '') : marks.has(first + i) ? 'mark' : '';
            return cls ? <div key={i} className={`v-code-line ${cls}`} style={{ top: `calc(6px + ${i} * 1.6em)` }} aria-hidden="true" /> : null;
          })}
          {numbers && (
            <pre className="v-code-gutter" aria-hidden="true">
              {lines.map((_, i) => first + i).join('\n')}
            </pre>
          )}
          {html !== null ? <pre className="v-code-text hljs" dangerouslySetInnerHTML={{ __html: html }} /> : <pre className="v-code-text">{code.code}</pre>}
        </div>
      </div>
    </div>
  );
}

/** Plain text with `code` spans. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/);
  return (
    <>
      {parts.map((p, i) =>
        p.length > 2 && p.startsWith('`') && p.endsWith('`') ? <code key={i}>{p.slice(1, -1)}</code> : <Fragment key={i}>{p}</Fragment>,
      )}
    </>
  );
}
