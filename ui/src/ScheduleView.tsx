import { useEffect, useState, type FormEvent } from 'react';
import { commands, type AgentRecord, type EffortLevel, type ScheduledTask, type ScheduleSpec, type ScheduleTarget } from './api';
import { lastSeen, recentChatFolders, store, transcriptPin, useManager } from './store';
import { duration, money } from './status';
import { MenuIcon } from './icons';
import { effortLevels, useModels } from './models';

const when = (at: string) => new Date(at).toLocaleString();
const localInput = (at: string) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; };
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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

function ScheduleForm({ task, agentId, agents, onSelect, onClose, onOpenDrawer }: { task?: ScheduledTask; agentId?: string; agents: Map<string, AgentRecord>; onSelect: (id: string) => void; onClose?: () => void; onOpenDrawer?: () => void }) {
  const models = useModels();
  const [name, setName] = useState(task?.name ?? '');
  const [prompt, setPrompt] = useState(task?.prompt ?? '');
  const [targetKind, setTargetKind] = useState<'newChat' | 'agent'>(task?.target.kind ?? (agentId ? 'agent' : 'newChat'));
  const [targetId, setTargetId] = useState(task?.target.kind === 'agent' ? task.target.agentId : agentId ?? '');
  const [folder, setFolder] = useState(task?.target.kind === 'newChat' ? task.target.cwd : '');
  const [model, setModel] = useState(task?.target.kind === 'newChat' ? task.target.model ?? '' : '');
  const [effort, setEffort] = useState(task?.target.kind === 'newChat' ? task.target.effort ?? '' : '');
  const [mode, setMode] = useState(() => task?.schedule.kind === 'manual' ? 'manual' : task?.schedule.kind === 'once' ? 'once' : task?.schedule.kind === 'cron' && !task.schedule.label ? 'cron' : task?.schedule.kind === 'cron' && task.schedule.label?.startsWith('Weekdays') ? 'weekdays' : task?.schedule.kind === 'cron' && task.schedule.label?.startsWith('Weekly') ? 'weekly' : task?.schedule.kind === 'cron' && /^(Hourly|Every \d+ hour)/.test(task.schedule.label ?? '') ? 'hourly' : 'daily');
  const [time, setTime] = useState(() => task?.schedule.kind === 'cron' && /^\d+$/.test(task.schedule.cron.split(' ')[1]) ? `${String(task.schedule.cron.split(' ')[1]).padStart(2, '0')}:${String(task.schedule.cron.split(' ')[0]).padStart(2, '0')}` : '09:00');
  const [everyHours, setEveryHours] = useState(() => task?.schedule.kind === 'cron' && task.schedule.cron.split(' ')[1].startsWith('*/') ? +task.schedule.cron.split(' ')[1].slice(2) : 1);
  const [days, setDays] = useState<number[]>(() => task?.schedule.kind === 'cron' && task.schedule.label?.startsWith('Weekly') ? task.schedule.cron.split(' ')[4].split(',').map(Number) : [1]);
  const [cron, setCron] = useState(task?.schedule.kind === 'cron' ? task.schedule.cron : '0 9 * * *');
  const [once, setOnce] = useState(task?.schedule.kind === 'once' ? localInput(task.schedule.at) : '');
  const [missedRuns, setMissedRuns] = useState<ScheduledTask['missedRuns']>(task?.missedRuns ?? 'ask');
  const [unattended, setUnattended] = useState<ScheduledTask['unattended']>(task?.unattended ?? 'deny');
  const [keepRuns, setKeepRuns] = useState(task?.keepRuns ?? 5);
  const [times, setTimes] = useState<string[]>([]);
  const [previewError, setPreviewError] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { void commands.info().then((info) => { if (!folder) setFolder(info.orchestratorFolder); if (!task) setMissedRuns(info.scheduleMissedRuns); }).catch(() => {}); }, []);
  const spec = (): ScheduleSpec => mode === 'manual' ? { kind: 'manual' } : mode === 'once' ? { kind: 'once', at: new Date(once).toISOString() } :
    mode === 'cron' ? { kind: 'cron', cron } : { kind: 'cron', cron: mode === 'hourly' ? `0 ${everyHours === 1 ? '*' : `*/${everyHours}`} * * *` : `${+time.split(':')[1]} ${+time.split(':')[0]} * * ${mode === 'weekdays' ? '1-5' : mode === 'weekly' ? days.join(',') : '*'}`, label: mode === 'hourly' ? `Every ${everyHours} hour${everyHours === 1 ? '' : 's'}` : mode === 'weekly' ? `Weekly ${days.map((d) => weekdays[d]).join(', ')} ${time}` : `${mode[0].toUpperCase() + mode.slice(1)} ${time}` };
  useEffect(() => { const timer = setTimeout(() => { try { void commands.schedulePreview(spec()).then((r) => { setTimes(r.times); setPreviewError(''); }).catch((e) => setPreviewError(e.message)); } catch (e) { setPreviewError((e as Error).message); } }, 250); return () => clearTimeout(timer); }, [mode, time, everyHours, days.join(','), cron, once]);
  const save = async (e: FormEvent, paused = false) => { e.preventDefault(); setError(''); try {
    const target: ScheduleTarget = targetKind === 'agent' ? { kind: 'agent', agentId: targetId } : { kind: 'newChat', cwd: folder, model: model || null, effort: (effort || null) as EffortLevel | null };
    const input = { name, prompt, target, schedule: spec(), missedRuns, unattended, keepRuns };
    const saved = task ? await commands.updateSchedule(task.id, input) : await commands.createSchedule({ ...input, paused });
    store.upsertSchedule(saved); onSelect(`schedule:${saved.id}`);
  } catch (e) { setError((e as Error).message); } };
  return <form className="schedule-view schedule-form" onSubmit={(e) => void save(e)}>
    <header className="schedule-head">{onOpenDrawer && <button type="button" className="icon-button" onClick={onOpenDrawer} aria-label="Open sidebar"><MenuIcon size={16} /></button>}<h2>{task ? `Edit · ${task.name}` : 'New scheduled task'}</h2>{onClose && <button type="button" className="icon-button" onClick={onClose} aria-label="Close pane">×</button>}</header>
    <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
    <label>Prompt<textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={6} required /></label>
    <label>Target<select value={targetKind} onChange={(e) => setTargetKind(e.target.value as 'newChat' | 'agent')}><option value="newChat">New chat each run</option><option value="agent">Existing agent</option></select></label>
    {targetKind === 'newChat' ? <><label>Folder<input list="schedule-folders" value={folder} onChange={(e) => setFolder(e.target.value)} required /><datalist id="schedule-folders">{recentChatFolders(agents).map((dir) => <option key={dir} value={dir} />)}</datalist></label><label>Model<input list="schedule-models" value={model} onChange={(e) => { setModel(e.target.value); setEffort(''); }} placeholder="Default" /><datalist id="schedule-models">{models?.map((m) => <option key={m.value} value={m.value}>{m.displayName}</option>)}</datalist></label><label>Effort<select value={effort} onChange={(e) => setEffort(e.target.value)}><option value="">Model default</option>{effortLevels(model || 'default').map((v) => <option key={v}>{v}</option>)}</select></label></> : <label>Agent<select value={targetId} onChange={(e) => setTargetId(e.target.value)} required><option value="">Choose an agent</option>{[...agents.values()].filter((a) => !a.archived).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}
    <label>Schedule<select value={mode} onChange={(e) => setMode(e.target.value)}>{['hourly','daily','weekdays','weekly','once','manual','cron'].map((v) => <option key={v} value={v}>{v === 'cron' ? 'Custom cron' : v === 'once' ? 'Once' : v === 'manual' ? 'Manual only' : v[0].toUpperCase() + v.slice(1)}</option>)}</select></label>
    {['daily','weekdays','weekly'].includes(mode) && <label>Time<input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>}
    {mode === 'hourly' && <label>Every hours<select value={everyHours} onChange={(e) => setEveryHours(+e.target.value)}>{[1,2,3,4,6,8,12,24].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>}
    {mode === 'weekly' && <div className="schedule-days">{weekdays.map((day, i) => <label key={day}><input type="checkbox" checked={days.includes(i)} onChange={() => setDays(days.includes(i) ? days.filter((d) => d !== i) : [...days, i].sort())} />{day}</label>)}</div>}
    {mode === 'cron' && <label>Cron<input value={cron} onChange={(e) => setCron(e.target.value)} /></label>}
    {mode === 'once' && <label>Run at<input type="datetime-local" value={once} onChange={(e) => setOnce(e.target.value)} /></label>}
    <p className={previewError ? 'schedule-error' : 'mono muted'}>{previewError || (times.length ? `Next: ${times.map(when).join(' · ')}` : mode === 'manual' ? 'Runs manually' : 'No upcoming runs')}</p>
    <label>Missed runs<select value={missedRuns} onChange={(e) => setMissedRuns(e.target.value as ScheduledTask['missedRuns'])}><option value="run">Run once</option><option value="ask">Ask me</option><option value="skip">Skip</option></select></label>
    <details><summary>Advanced</summary><label>When permission is needed<select value={unattended} onChange={(e) => setUnattended(e.target.value as ScheduledTask['unattended'])}><option value="deny">Deny and continue</option><option value="ask">Ask and wait</option></select></label>{targetKind === 'newChat' && <label>Keep runs<input type="number" min="0" max="50" value={keepRuns} onChange={(e) => setKeepRuns(+e.target.value)} /></label>}</details>
    {error && <p className="schedule-error" role="alert">{error}</p>}
    <div className="schedule-actions"><button className="primary" type="submit">{task ? 'Save' : 'Create'}</button>{!task && <button type="button" onClick={(e) => void save(e as unknown as FormEvent, true)}>Create paused</button>}</div>
  </form>;
}
