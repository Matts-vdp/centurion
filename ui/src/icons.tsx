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
  ChevronDown as ChevronDownIcon,
  CircleX as ErrorIcon,
  Copy as CopyIcon,
  Ellipsis as MoreIcon,
  FilePen as EditIcon,
  FilePlus as WriteIcon,
  FileCode as FileCodeIcon,
  FileImage as FileImageIcon,
  FileText as FileIcon,
  Folder as FolderIcon,
  FolderOpen as FolderOpenIcon,
  GitBranch as ForkIcon,
  FolderSearch as GlobIcon,
  Globe as WebIcon,
  ImagePlus as AttachImageIcon,
  ListTodo as TodoIcon,
  Menu as MenuIcon,
  Plus as PlusIcon,
  RefreshCw as RefreshIcon,
  Search as SearchIcon,
  Square as StopIcon,
  Undo2 as RewindIcon,
  SquareTerminal as TerminalIcon,
  Wrench as ToolIcon,
  X as CloseIcon,
} from 'lucide-react';

/** A chevron that points right when closed and down when open. */
export function Chevron({ open, className, ...p }: LucideProps & { open: boolean }) {
  return <ChevronRight {...p} className={`chevron-icon${open ? ' open' : ''}${className ? ` ${className}` : ''}`} aria-hidden="true" />;
}
