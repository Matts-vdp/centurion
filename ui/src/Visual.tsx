import { Fragment, useMemo, useState } from 'react';
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
  type LucideIcon,
} from 'lucide-react';
import type { AgentRecord } from './api';
import { fileLinks, joinPath } from './fileStore';
import { OpenIcon } from './icons';
import { nameHue } from './status';
import {
  parseVisual,
  type VisualCard,
  type VisualContainer,
  type VisualIcon,
  type VisualNode,
  type VisualTone,
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
 * cards that sit in a row or column get a hairline box, cards inside a card are rows without one, and
 * colour only comes from tone and repo.
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
  if (node.type === 'card') return <CardView card={node} inCard={inCard} ctx={ctx} />;
  if (node.type === 'column') return <ColumnView column={node} inCard={inCard} ctx={ctx} />;
  return <RowView row={node} inCard={inCard} ctx={ctx} />;
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

function CardView({ card, inCard, ctx }: { card: VisualCard; inCard: boolean; ctx: Ctx }) {
  const iconName = card.icon ?? (card.tone ? TONE_ICON[card.tone] : undefined);
  const Icon = iconName ? ICONS[iconName] : null;
  const icon = Icon ? <Icon className="v-icon" size={16} aria-hidden="true" /> : null;
  const badge = card.badge ? <span className="v-badge">{card.badge}</span> : null;
  const repo = card.repo ? (
    <span className="v-repo repo-hue" data-hue={nameHue(card.repo)}>
      {card.repo}
    </span>
  ) : null;
  const title = <LinkedTitle card={card} ctx={ctx} />;
  const cls = `${inCard ? 'v-item' : 'v-card'}${card.tone ? ` tone-${card.tone}` : ''}${card.value !== undefined ? ' value' : ''}${icon ? ' has-icon' : ''}`;
  return (
    <div className={cls}>
      {card.value !== undefined ? (
        <>
          <div className="v-value">{card.value}</div>
          <div className="v-head">
            {icon}
            {title}
            {repo}
            {badge}
          </div>
        </>
      ) : (
        <div className="v-head">
          {icon}
          {title}
          {repo}
          {badge}
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
    </div>
  );
}

/** A card's title, as a link when it has one the app can follow. */
function LinkedTitle({ card, ctx }: { card: VisualCard; ctx: Ctx }) {
  const link = card.link ?? '';
  const label = <span className="v-title">{card.title}</span>;
  if (/^https?:\/\//.test(link)) {
    return (
      <a className="v-link" href={link} target="_blank" rel="noreferrer" title={link}>
        {label}
        <OpenIcon size={12} aria-hidden="true" />
      </a>
    );
  }
  if (link.startsWith('expert:')) {
    const target = findAgent(link.slice(7).trim(), ctx);
    if (target) {
      return (
        <button className="v-link" title={`Open ${target.name}`} onClick={() => ctx.onSelect(target.id)}>
          {label}
          <OpenIcon size={12} aria-hidden="true" />
        </button>
      );
    }
  }
  if (link.startsWith('file:')) {
    const p = link.slice(5).trim();
    const full = /^([a-zA-Z]:[\\/]|[\\/])/.test(p) ? p : joinPath(ctx.agent.cwd, p);
    return (
      <button className="v-link" title={`${full}\nOpen the file in the Files panel`} onClick={() => fileLinks.open({ agentId: ctx.agent.id, path: full, mode: 'file' })}>
        {label}
        <OpenIcon size={12} aria-hidden="true" />
      </button>
    );
  }
  return label;
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
