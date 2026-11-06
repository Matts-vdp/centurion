// The app's one icon set: Lucide, 16 px by default. Stroke width comes from `svg.lucide` in styles.css.
import { ChevronRight, type LucideProps } from 'lucide-react';

export {
  Archive as ArchiveIcon,
  ArrowLeft as BackIcon,
  ArrowUp as SendIcon,
  ArrowUpRight as OpenIcon,
  Bell as BellIcon,
  Bot as BotIcon,
  Brain as ThinkIcon,
  Check as CheckIcon,
  CircleX as ErrorIcon,
  Copy as CopyIcon,
  Ellipsis as MoreIcon,
  FilePen as EditIcon,
  FilePlus as WriteIcon,
  FileText as FileIcon,
  Folder as FolderIcon,
  FolderSearch as GlobIcon,
  Globe as WebIcon,
  ListTodo as TodoIcon,
  Menu as MenuIcon,
  Plus as PlusIcon,
  Search as SearchIcon,
  Square as StopIcon,
  SquareTerminal as TerminalIcon,
  Wrench as ToolIcon,
  X as CloseIcon,
} from 'lucide-react';

/** A chevron that points right when closed and down when open. */
export function Chevron({ open, className, ...p }: LucideProps & { open: boolean }) {
  return <ChevronRight {...p} className={`chevron-icon${open ? ' open' : ''}${className ? ` ${className}` : ''}`} aria-hidden="true" />;
}
