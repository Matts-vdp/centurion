import { useState, type ReactNode } from 'react';
import type { AgentRecord } from './api';
import type { Delegation } from './blocks';
import { CheckIcon, ErrorIcon, OpenIcon } from './icons';
import { AgentMark } from './Mark';
import { runLabel, useModels } from './models';
import { agentState, duration, folderName, money, repoHue, type StateKey } from './status';
import { lastSeen, useManager } from './store';

type Props = {
  block: Delegation;
  agents: Map<string, AgentRecord>;
  /** The latest delegation to this expert: only that one shows the expert's live state. */
  isLatest: boolean;
  now: number;
  onSelect: (id: string) => void;
};

export type Status = { state?: StateKey; tone: 'running' | 'done' | 'waiting' | 'failed' | 'muted'; icon?: ReactNode; text: string; extra: string[] };

/**
 * The orchestrator asked an expert something. One object for the whole exchange: the request, the
 * expert's live state, and what came back (the notification and get_expert_output fold in here).
 */
export function DelegationView({ block, agents, isLatest, now, onSelect }: Props) {
  const { activity } = useManager();
  const seen = lastSeen.use();
  const [open, setOpen] = useState(false);
  useModels();
  const expert = block.expertId ? agents.get(block.expertId) : undefined;
  const name = expert?.name ?? block.expertName;
  const status = delegationStatus(block, expert, isLatest, now, (a) => agentState(a, agents, seen, activity.get(a.id), now).sentence);
  const created = block.tool.name.endsWith('create_expert');

  return (
    <div className="delegation">
      <AgentMark agent={{ name, kind: 'expert', cwd: expert?.cwd }} state={status.state} />
      <div className="delegation-main">
        <div className="delegation-title">
          <span className="delegation-verb">{created ? 'Started' : 'Asked'}</span>
          <span className="delegation-name">{name}</span>
          {expert && (
            <span className="mono delegation-folder" title={expert.cwd} data-hue={repoHue(expert.cwd)}>
              <span className="repo-hue">{folderName(expert.cwd)}</span> · {runLabel(expert)}
            </span>
          )}
        </div>
        {block.message && (
          <button className={`delegation-message${open ? ' open' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)} title={open ? 'Show less' : 'Show the whole message'}>
            {open ? block.message : (block.message.split('\n').find((l) => l.trim()) ?? '')}
          </button>
        )}
        <div className="delegation-status">
          <span className={`status-${status.tone}`}>
            {status.icon}
            {status.text}
          </span>
          {status.extra.map((x) => (
            <span key={x} className="delegation-extra">
              {x}
            </span>
          ))}
        </div>
      </div>
      {expert && (
        <button className="button secondary small delegation-open" onClick={() => onSelect(expert.id)}>
          Open <OpenIcon size={13} />
        </button>
      )}
    </div>
  );
}

function delegationStatus(
  block: Delegation,
  expert: AgentRecord | undefined,
  isLatest: boolean,
  now: number,
  sentence: (a: AgentRecord) => string,
): Status {
  const tool = block.tool;
  if (tool.isError || tool.denied) {
    const why = (tool.denied ?? tool.result ?? '').replace(/<\/?tool_use_error>/g, '').trim().split('\n')[0];
    return { state: 'failed', tone: 'failed', icon: <ErrorIcon size={13} />, text: why ? `Could not send: ${why}` : 'Could not send', extra: [] };
  }
  if (tool.result === undefined) return { tone: 'muted', text: 'Sending…', extra: [] };
  if (!expert) return { tone: 'muted', text: 'Sent', extra: [] };
  return expertStatus(expert, tool.startedAt, isLatest, now, sentence, block.read, block.notification?.text);
}

/**
 * How an expert's work on a message sent at `since` is going: its first reply after that, or (for the
 * latest message to it) its live state. Shared by delegations and the round tracker.
 */
export function expertStatus(
  expert: AgentRecord,
  since: number,
  isLatest: boolean,
  now: number,
  sentence: (a: AgentRecord) => string,
  wasRead = false,
  notification?: string,
): Status {
  const reply = expert.replies.find((r) => Date.parse(r.at) >= since);
  const read = wasRead ? ['Reply read'] : [];
  if (reply) {
    const after = duration(Date.parse(reply.at) - since);
    const cost = reply.costUsd !== undefined ? [money(reply.costUsd)] : [];
    if (reply.interrupted) return { state: 'interrupted', tone: 'waiting', text: `Interrupted after ${after}`, extra: read };
    if (reply.isError) {
      return { state: 'failed', tone: 'failed', icon: <ErrorIcon size={13} />, text: `Failed after ${after}`, extra: [firstLine(reply.text), ...read] };
    }
    return { state: 'unread', tone: 'done', icon: <CheckIcon size={13} />, text: `Replied after ${after}`, extra: [...read, ...cost] };
  }
  if (notification) {
    // The reply has scrolled out of the record's last replies; the notification still says what happened.
    const failed = /error|stopped/.test(notification);
    return { state: failed ? 'failed' : undefined, tone: failed ? 'failed' : 'done', text: capitalise(notification.split('.')[0]), extra: read };
  }
  if (!isLatest) return { tone: 'muted', text: 'Sent', extra: [] };
  if (expert.status === 'running') {
    const started = expert.turnStartedAt ? Date.parse(expert.turnStartedAt) : since;
    const doing = sentence(expert).replace(/ · [^·]+$/, '');
    return { state: 'running', tone: 'running', text: `Working · ${duration(now - started)}`, extra: doing.startsWith('Working') ? [] : [doing] };
  }
  if (expert.queue.length > 0) return { state: 'queued', tone: 'waiting', text: 'Queued', extra: [] };
  if (expert.status === 'stopped') return { state: 'stopped', tone: 'muted', text: 'Stopped', extra: [] };
  if (expert.status === 'error') return { state: 'failed', tone: 'failed', text: 'Failed', extra: [firstLine(expert.lastError ?? '')] };
  if (expert.status === 'interrupted') return { state: 'interrupted', tone: 'waiting', text: 'Interrupted', extra: [] };
  return { tone: 'muted', text: 'Sent', extra: [] };
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function firstLine(s: string, max = 100): string {
  const line = s.split('\n').find((l) => l.trim())?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
