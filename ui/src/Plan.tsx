import { useState } from 'react';
import { commands, type AgentRecord, type Plan, type Track } from './api';
import { expertStatus } from './Delegation';
import { BellIcon, Chevron, OpenIcon } from './icons';
import { AgentMark } from './Mark';
import { modelLabel, runLabel, useModels } from './models';
import { agentState, clock, folderName } from './status';
import { lastSeen, store, useManager } from './store';

type Props = {
  planId: string;
  /** The version this propose_tracks call made. */
  version: number;
  orchestrator: AgentRecord;
  agents: Map<string, AgentRecord>;
  now: number;
  onSelect: (id: string) => void;
  run: (a: () => Promise<unknown>) => Promise<void>;
};

/**
 * A round's track plan (docs/ui-design.md, section 8): waiting for the user with checkboxes and Start,
 * folded when a newer version replaced it, and the round's tracker once started.
 */
export function PlanView({ planId, version, orchestrator, agents, now, onSelect, run }: Props) {
  const { plans } = useManager();
  useModels();
  const plan = plans.get(planId);
  if (!plan) return null;
  // In a fork, the plan stays with the chat it was made in.
  if (plan.orchestratorId !== orchestrator.id || plan.status === 'dropped') {
    const owner = agents.get(plan.orchestratorId);
    const title = plan.versions[version - 1]?.title ?? '';
    return (
      <div className="foreign-object">
        Track plan{plan.status === 'dropped' ? ', rewound away' : owner ? ` from ${owner.name}` : ''} · Round {plan.round} · {title}
      </div>
    );
  }
  const v = plan.versions[version - 1];
  if (!v) return null;
  if (version < plan.versions.length) return <ReplacedVersion plan={plan} version={version} orchestrator={orchestrator} agents={agents} />;
  if (plan.status === 'waiting') return <WaitingPlan plan={plan} orchestrator={orchestrator} agents={agents} run={run} />;
  return <Tracker plan={plan} orchestrator={orchestrator} agents={agents} now={now} onSelect={onSelect} run={run} />;
}

// ---------- shared bits ----------

/**
 * Where a track runs, with its model and effort. A new expert without its own takes the orchestrator's
 * (and an existing one keeps its own), so the line shows those.
 */
function targetLine(t: Track, orchestrator: AgentRecord, agents: Map<string, AgentRecord>): string {
  const parts: string[] = [];
  let runsOn: AgentRecord | undefined = orchestrator;
  if (t.target.kind === 'new_expert') {
    parts.push('New expert', folderName(t.target.folder ?? orchestrator.cwd));
    if (t.target.taskFolder) parts.push(`task folder ${folderName(t.target.taskFolder)}`);
  } else if (t.target.kind === 'existing_expert') {
    const e = agents.get(t.target.expertId);
    parts.push(`${e?.name ?? t.target.expertId} (existing)`);
    if (e) parts.push(folderName(e.cwd));
    runsOn = e;
  } else parts.push(`Subagent of ${orchestrator.name}`);
  if (t.model || t.effort) {
    parts.push(...[t.model ? modelLabel(t.model) : '', t.effort ?? ''].filter(Boolean));
  } else if (runsOn && t.target.kind !== 'subagent') {
    parts.push(runLabel(runsOn));
  }
  return parts.join(' · ');
}

/** 'new' or 'changed' compared with the previous version, if there is one. */
function changedSince(plan: Plan, t: Track): 'new' | 'changed' | null {
  const n = plan.versions.length;
  if (n < 2) return null;
  const before = plan.versions[n - 2].tracks.find((x) => x.id === t.id);
  if (!before) return 'new';
  return JSON.stringify(before) !== JSON.stringify(t) ? 'changed' : null;
}

function LaterRounds({ plan }: { plan: Plan }) {
  const [open, setOpen] = useState(false);
  const later = plan.versions.at(-1)!.later;
  if (later.length === 0) return null;
  return (
    <div className={`plan-later${open ? ' open' : ''}`}>
      <button className="plan-later-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Chevron open={open} size={14} />
        <span className="plan-later-label">
          Then · {later.length} later round{later.length === 1 ? '' : 's'}
        </span>
        {!open && <span className="plan-later-titles">{later.map((r) => r.title).join(' → ')}</span>}
        <span className="plan-later-note">for information</span>
      </button>
      {open && (
        <div className="plan-later-body">
          {later.map((r) => (
            <div key={r.round} className="plan-later-round">
              <div className="plan-later-round-title">
                <span className="tag">Round {r.round}</span> {r.title}
              </div>
              <ul>
                {r.tracks.map((t, i) => (
                  <li key={i}>
                    <span className="plan-later-track">{t.title}</span>
                    {t.summary && <span className="plan-later-summary"> · {t.summary}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- waiting for the user ----------

function WaitingPlan({
  plan,
  orchestrator,
  agents,
  run,
}: {
  plan: Plan;
  orchestrator: AgentRecord;
  agents: Map<string, AgentRecord>;
  run: (a: () => Promise<unknown>) => Promise<void>;
}) {
  const v = plan.versions.at(-1)!;
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const checked = v.tracks.filter((t) => !unchecked.has(t.id));
  const toggle = (id: string) =>
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const start = async () => {
    setBusy(true);
    await run(async () => {
      const updated = await commands.startPlan(
        plan.id,
        checked.map((t) => t.id),
        v.tracks.filter((t) => unchecked.has(t.id)).map((t) => t.id),
      );
      store.upsertPlan(updated);
    });
    setBusy(false);
  };

  return (
    <section className="plan waiting" aria-label={`Round ${plan.round} plan, waiting for you`}>
      <div className="plan-head">
        <span className="tag">
          Round {plan.round}
          {plan.versions.length > 1 ? ` · v${v.version}` : ''}
        </span>
        <h3 className="plan-title">{v.title}</h3>
        <span className="plan-state waiting">Waiting for you</span>
      </div>
      <div className="plan-tracks">
        {v.tracks.map((t, i) => {
          const on = !unchecked.has(t.id);
          return (
            <label key={t.id} className={`plan-track${on ? '' : ' off'}`}>
              <input type="checkbox" checked={on} onChange={() => toggle(t.id)} />
              <span className="plan-num mono">{i + 1}</span>
              <span className="plan-track-text">
                <span className="plan-track-title">
                  {t.title}
                  {changedSince(plan, t) && (
                    <span className="plan-changed">
                      {' '}
                      {changedSince(plan, t)} in v{v.version}
                    </span>
                  )}
                </span>
                <span className="plan-target mono">{targetLine(t, orchestrator, agents)}</span>
                <span className="plan-summary">{t.summary}</span>
              </span>
            </label>
          );
        })}
      </div>
      <LaterRounds plan={plan} />
      <div className="plan-foot">
        <span className="plan-foot-text">
          {checked.length} of {v.tracks.length} tracks{checked.length > 1 ? ', in parallel' : ''}. Start sends only the checked tracks.
        </span>
        <button className="button primary" disabled={checked.length === 0 || busy} onClick={() => void start()}>
          Start {checked.length} track{checked.length === 1 ? '' : 's'}
        </button>
      </div>
    </section>
  );
}

function ReplacedVersion({ plan, version, orchestrator, agents }: { plan: Plan; version: number; orchestrator: AgentRecord; agents: Map<string, AgentRecord> }) {
  const [open, setOpen] = useState(false);
  const v = plan.versions[version - 1];
  return (
    <div className={`plan-replaced${open ? ' open' : ''}`}>
      <button className="plan-replaced-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Chevron open={open} size={14} />
        <span className="mono">
          Round {plan.round} · v{version}
        </span>
        <span className="plan-replaced-title">{v.title}</span>
        <span className="plan-replaced-meta">
          · {v.tracks.length} track{v.tracks.length === 1 ? '' : 's'} · Replaced by v{plan.versions.length}
        </span>
      </button>
      {open && (
        <ol className="plan-replaced-list">
          {v.tracks.map((t) => (
            <li key={t.id}>
              <span className="plan-track-title">{t.title}</span>
              <span className="plan-target mono">{targetLine(t, orchestrator, agents)}</span>
              <span className="plan-summary">{t.summary}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ---------- the round's tracker ----------

type Row =
  | { kind: 'expert'; track: Track; expert: AgentRecord }
  | { kind: 'pending'; track: Track }
  | { kind: 'subagent'; track: Track }
  | { kind: 'skipped'; track: Track };

function Tracker({
  plan,
  orchestrator,
  agents,
  now,
  onSelect,
  run,
}: {
  plan: Plan;
  orchestrator: AgentRecord;
  agents: Map<string, AgentRecord>;
  now: number;
  onSelect: (id: string) => void;
  run: (a: () => Promise<unknown>) => Promise<void>;
}) {
  const { activity } = useManager();
  const seen = lastSeen.use();
  const v = plan.versions.at(-1)!;
  const since = plan.startedAt ? Date.parse(plan.startedAt) : Date.parse(plan.createdAt);
  const sentence = (a: AgentRecord) => agentState(a, agents, seen, activity.get(a.id), now).sentence;

  const rows: Row[] = v.tracks.map((track) => {
    const expertId = plan.experts[track.id];
    const expert = expertId ? agents.get(expertId) : undefined;
    if (expert) return { kind: 'expert', track, expert };
    if (plan.skipped?.includes(track.id) || (plan.chosen && !plan.chosen.includes(track.id))) return { kind: 'skipped', track };
    if (!plan.chosen) return { kind: 'skipped', track }; // started from the chat: only what was actually started counts
    if (track.target.kind === 'subagent') return { kind: 'subagent', track };
    return { kind: 'pending', track };
  });
  const active = rows.filter((r) => r.kind !== 'skipped');
  const statuses = new Map(
    rows.flatMap((r) => (r.kind === 'expert' ? [[r.track.id, expertStatus(r.expert, since, true, now, sentence)] as const] : [])),
  );
  const replied = [...statuses.values()].filter((s) => s.tone === 'done' || s.tone === 'failed').length;
  const experts = rows.filter((r) => r.kind === 'expert').length;
  const waitingFor = active.filter((r) => r.kind === 'expert' || r.kind === 'pending').length;
  const complete = experts > 0 && replied === experts && rows.every((r) => r.kind !== 'pending');

  return (
    <section className="plan started" data-plan={plan.id} aria-label={`Round ${plan.round}, started`}>
      <div className="plan-head">
        <span className="tag">Round {plan.round}</span>
        <h3 className="plan-title">{v.title}</h3>
        <span className="plan-state">
          {plan.startedAt ? `Started ${clock(plan.startedAt)} · ` : ''}
          {replied} of {waitingFor} replied
        </span>
      </div>
      <div className="plan-progress" aria-hidden="true">
        {active.map((r) => {
          const s = statuses.get(r.track.id);
          const tone = s ? s.tone : r.kind === 'subagent' ? 'muted' : 'pending';
          return <span key={r.track.id} className={`segment ${tone}`} />;
        })}
      </div>
      {rows.map((r, i) => {
        if (r.kind === 'skipped') {
          return (
            <div key={r.track.id} className="tracker-row skipped">
              <span className="plan-num mono">{i + 1}</span>
              <span>
                {plan.chosen ? 'Skipped' : 'Not started'}: {r.track.title}
              </span>
            </div>
          );
        }
        if (r.kind !== 'expert') {
          return (
            <div key={r.track.id} className="tracker-row muted">
              <span className="plan-num mono">{i + 1}</span>
              <span className="tracker-text">
                <span className="tracker-title">{r.track.title}</span>
                <span className="tracker-status">
                  {r.kind === 'subagent' ? `Run by ${orchestrator.name} as a subagent` : 'Not started yet'}
                </span>
              </span>
            </div>
          );
        }
        const s = statuses.get(r.track.id)!;
        const reply = r.expert.replies.find((x) => Date.parse(x.at) >= since && !x.isError && !x.interrupted);
        const meta = `${folderName(r.expert.cwd)} · ${runLabel(r.expert)}`;
        return (
          <button key={r.track.id} className="tracker-row" onClick={() => onSelect(r.expert.id)} title={`Open ${r.expert.name}`}>
            <span className="plan-num mono">{i + 1}</span>
            <AgentMark agent={r.expert} state={s.state} />
            <span className="tracker-text">
              <span className="tracker-title">
                <span className="tracker-name">{r.expert.name}</span>
                <span className="mono tracker-meta">{meta}</span>
              </span>
              <span className="tracker-status">
                <span className={`status-${s.tone}`}>{s.text}</span>
                {reply && s.tone === 'done' ? <span> · {firstLine(reply.text)}</span> : s.extra.length ? <span> · {s.extra.join(' · ')}</span> : null}
              </span>
            </span>
            <OpenIcon size={14} />
          </button>
        );
      })}
      <div className="plan-foot tracker-foot">
        <BellIcon size={14} />
        <span className="plan-foot-text">
          {complete
            ? `Every started track replied. ${orchestrator.name} has been notified.`
            : plan.notify === 'round'
              ? `${orchestrator.name} gets one combined notification when every started track has replied`
              : `${orchestrator.name} is notified after each reply`}
        </span>
        {!complete && (
          <button
            className="button secondary small"
            onClick={() =>
              void run(async () => store.upsertPlan(await commands.setPlanNotify(plan.id, plan.notify === 'round' ? 'each' : 'round')))
            }
          >
            {plan.notify === 'round' ? 'Notify on each reply' : 'Notify once per round'}
          </button>
        )}
      </div>
    </section>
  );
}

function firstLine(s: string, max = 120): string {
  const line = s.split('\n').find((l) => l.trim())?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
