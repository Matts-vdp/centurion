import type { AgentRecord } from './api';
import type { ToolItem } from './timeline';

const MANAGER_PREFIX = 'mcp__manager__';

export function displayName(name: string): string {
  if (name.startsWith(MANAGER_PREFIX)) return name.slice(MANAGER_PREFIX.length);
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  return mcp ? `${mcp[2]} (${mcp[1]})` : name;
}

const firstLine = (v: unknown, max = 160): string => {
  const s = typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
  const line = s.split('\n').find((l) => l.trim()) ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

/** Shorten an absolute path to its last few segments. */
export function shortPath(p: unknown): string {
  if (typeof p !== 'string') return '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : p;
}

const baseName = (p: unknown): string => (typeof p === 'string' ? (p.split(/[\\/]/).filter(Boolean).at(-1) ?? p) : '');

/** A short human detail for a running tool: Bash's description, a file name, a pattern. */
export function toolDetail(name: string, i: Record<string, unknown>): string {
  switch (displayName(name)) {
    case 'Bash':
      return firstLine(i.description ?? i.command, 80);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return baseName(i.file_path ?? i.notebook_path);
    case 'Grep':
      return `"${firstLine(i.pattern, 60)}"`;
    case 'Glob':
      return firstLine(i.pattern, 60);
    case 'WebFetch':
      return firstLine(i.url, 80);
    case 'WebSearch':
      return firstLine(i.query, 80);
    case 'Task':
    case 'Agent':
      return firstLine(i.description, 80);
    case 'create_expert':
      return firstLine(i.name, 60);
    default:
      return '';
  }
}

/** One-line summary shown on a collapsed tool card. */
export function summarize(tool: ToolItem, agents: Map<string, AgentRecord>): string {
  const i = tool.input;
  const expert = (id: unknown) => (typeof id === 'string' ? (agents.get(id)?.name ?? id) : '');
  switch (displayName(tool.name)) {
    case 'Bash':
      return firstLine(i.command);
    case 'Read':
    case 'Write':
    case 'NotebookEdit':
      return shortPath(i.file_path ?? i.notebook_path);
    case 'Edit':
      return `${shortPath(i.file_path)}  ${firstLine(i.old_string, 40)} → ${firstLine(i.new_string, 40)}`;
    case 'Grep':
      return `${firstLine(i.pattern)}${i.path ? `  in ${shortPath(i.path)}` : ''}`;
    case 'Glob':
      return firstLine(i.pattern);
    case 'WebFetch':
      return firstLine(i.url);
    case 'WebSearch':
      return firstLine(i.query);
    case 'Task':
    case 'Agent':
      return firstLine(i.description ?? i.prompt);
    case 'TodoWrite':
      return Array.isArray(i.todos) ? `${i.todos.length} items` : '';
    case 'create_expert':
      return `${firstLine(i.name)}${i.message ? `: ${firstLine(i.message, 100)}` : ''}`;
    case 'message_expert':
      return `${expert(i.expert_id)}: ${firstLine(i.message, 100)}`;
    case 'get_expert_output':
    case 'stop_expert':
      return expert(i.expert_id);
    default: {
      const value = Object.values(i).find((v) => typeof v === 'string');
      return firstLine(value ?? (Object.keys(i).length ? i : ''));
    }
  }
}

/** The expert a manager tool card links to: the id from the result JSON, or `expert_id` from the input. */
export function linkedExpert(tool: ToolItem): string | null {
  const name = displayName(tool.name);
  if (!['create_expert', 'message_expert', 'get_expert_output', 'stop_expert'].includes(name)) return null;
  if (typeof tool.input.expert_id === 'string') return tool.input.expert_id;
  if (tool.result && !tool.isError) {
    try {
      const parsed = JSON.parse(tool.result) as { id?: unknown };
      if (typeof parsed.id === 'string') return parsed.id;
    } catch {
      // not JSON
    }
  }
  return null;
}
