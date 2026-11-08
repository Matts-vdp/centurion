import { useEffect, useState } from 'react';
import { commands, type AgentRecord, type ScheduledTask, type ScheduleSpec } from './api';
import { lastSeen, store, transcriptPin, useManager } from './store';
import { duration, money } from './status';
import { MenuIcon } from './icons';
import { ScheduleForm } from './ScheduleForm';

const when = (at: string) => new Date(at).toLocaleString();

export function ScheduleView({ paneId, agents, onSelect, onClose, onOpenDrawer }: { paneId: string; agents: Map<string, AgentRecord>; onSelect: (id: string) => void; onClose?: () => void; onOpenDrawer?: () => void }) {
  const { schedules } = useManager();
  const parts = paneId.split(':');
  const editing = parts[1] === 'edit';
  const creating = parts[1] === 'new';
  const id = editing ? parts[2] : parts[1];
  const task = schedules.get(id);
  if (creating || editing) return <ScheduleForm key={paneId} task={task} agentId={creating ? parts[2] : undefined} agents={agents} onSelect={onSelect} onClose={onClose} onOpenDrawer={onOpenDrawer} />;
  if (!task) return <div className="schedule-view"><p>That scheduled task no longer exists.</p><button onClick={onClose}>Close</button></div>;
  return <TaskPage task={task} agents={agents} onSelect={onSelect} onClose={onClose} onOpenDrawer={onOpenDrawer} />;
}

function TaskPage({ task, agents, onSelect, onClose, onOpenDrawer }: { task: ScheduledTask; agents: Map<string, AgentRecord>; onSelect: (id: string) => void; onClose?: () => void; onOpenDrawer?: () => void }) {
  useEffect(() => { if (document.visibilityState === 'visible') lastSeen.set(task.id, task.runs.at(-1)?.endedAt ?? task.runs.at(-1)?.dueAt ?? task.createdAt); }, [task.id]);
  const [error, setError] = useState('');
  const [upcoming, setUpcoming] = useState<string[]>([]);
  const act = async (fn: () => Promise<unknown>) => { try { setError(''); await fn(); } catch (e) { setError((e as Error).message); } };
  useEffect(() => { void commands.schedulePreview(task.schedule).then((r) => setUpcoming(r.times)).catch(() => setUpcoming([])); }, [task.schedule]);
  const pending = task.runs.find((r) => r.status === 'pending');
  const latest = [...task.runs].reverse();
  const target = task.target.kind === 'agent' ? agents.get(task.target.agentId)?.name ?? 'Missing agent' : `New chat in ${task.target.cwd}`;
  const archivedTarget = task.target.kind === 'agent' && agents.get(task.target.agentId)?.archived;
  const failed = task.runs.at(-1)?.status === 'failed';
  return <div className="schedule-view">
    <header className="schedule-head">{onOpenDrawer && <button className="icon-button" onClick={onOpenDrawer} aria-label="Open sidebar"><MenuIcon size={16} /></button>}<div><div className="schedule-eyebrow">Scheduled · {task.name}</div><h2>{archivedTarget ? 'Paused · its chat is archived' : task.status === 'active' && task.nextAt ? `Active · next ${when(task.nextAt)}` : task.status[0].toUpperCase() + task.status.slice(1)}</h2></div>
      {onClose && <button className="icon-button" onClick={onClose} aria-label="Close pane">×</button>}</header>
    <div className="schedule-actions">
      {task.status === 'proposed' ? <button className="primary" onClick={() => void act(async () => { store.upsertSchedule(await commands.activateSchedule(task.id)); })}>Activate</button> : <button className="primary" onClick={() => void act(() => commands.runSchedule(task.id))}>Run now</button>}
      {task.status !== 'proposed' && <button onClick={() => void act(async () => { store.upsertSchedule(await commands.pauseSchedule(task.id, task.status !== 'paused')); })}>{task.status === 'paused' ? 'Resume' : 'Pause'}</button>}
      <button onClick={() => onSelect(`schedule:edit:${task.id}`)}>Edit</button>
      <button onClick={() => void act(async () => { const copy = await commands.createSchedule({ name: `${task.name} copy`, prompt: task.prompt, target: task.target, schedule: task.schedule, missedRuns: task.missedRuns, unattended: task.unattended, keepRuns: task.keepRuns, paused: true }); store.upsertSchedule(copy); onSelect(`schedule:${copy.id}`); })}>Duplicate</button>
      <button onClick={() => { if (window.confirm(`Delete scheduled task “${task.name}”?`)) void act(async () => { await commands.deleteSchedule(task.id); onClose?.(); }); }}>Delete</button>
    </div>
    {error && <p role="alert" className="schedule-error">{error}</p>}
    {failed && <p className="schedule-error">Last run failed · {task.runs.at(-1)?.reason}</p>}
    {pending && <div className="schedule-pending">Missed {when(pending.dueAt)} · <button onClick={() => void act(() => commands.runSchedule(task.id))}>Run now</button><button onClick={() => void act(() => commands.skipSchedule(task.id))}>Skip</button></div>}
    <dl className="schedule-details"><dt>Schedule</dt><dd>{describe(task.schedule)}</dd><dt>Next</dt><dd className="mono">{upcoming.length ? upcoming.map(when).join(' · ') : task.nextAt ? when(task.nextAt) : task.status === 'done' ? 'Completed' : 'Manual only'}</dd><dt>Target</dt><dd>{task.target.kind === 'agent' ? <button className="link-button" onClick={() => onSelect((task.target as { agentId: string }).agentId)}>{target}</button> : target}</dd>
      <dt>Missed runs</dt><dd>{task.missedRuns === 'run' ? 'Run once' : task.missedRuns === 'ask' ? 'Ask me' : 'Skip'}</dd><dt>Permissions</dt><dd>{task.unattended === 'deny' ? 'Deny and continue' : 'Ask and wait'}</dd>{task.target.kind === 'newChat' && <><dt>Keep runs</dt><dd>{task.keepRuns}</dd></>}</dl>
    <h3>Prompt</h3><div className="schedule-prompt">{task.prompt}</div>
    <h3>History</h3>{!latest.length && <p className="muted">No runs yet.</p>}
    <div className="schedule-history">{latest.map((run) => <div key={run.id} className="schedule-history-row"><time className="mono">{when(run.dueAt)}</time><div><strong>{run.status}</strong>{run.trigger !== 'schedule' && ` · ${run.trigger === 'catchUp' ? 'Catch-up' : 'Run now'}`}<span> · {run.reason ?? run.preview ?? ''}</span>{run.durationMs !== undefined ? ` · ${duration(run.durationMs)}` : ''}{run.costUsd !== undefined ? <span className="schedule-cost"> · {money(run.costUsd)}</span> : null}{run.denied ? ` · ${run.denied} permissions denied` : ''}</div>{run.agentId && <button className="link-button" onClick={() => { if (run.promptUuid) transcriptPin.set({ agentId: run.agentId!, at: Date.now(), promptUuid: run.promptUuid }); onSelect(run.agentId!); }}>Open</button>}</div>)}</div>
  </div>;
}

function describe(spec: ScheduleSpec): string { return spec.kind === 'manual' ? 'Manual only' : spec.kind === 'once' ? `Once ${when(spec.at)}` : spec.label ?? `Cron ${spec.cron}`; }
