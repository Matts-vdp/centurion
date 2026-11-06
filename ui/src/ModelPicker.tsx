import { useEffect, useRef, useState } from 'react';
import { commands, EFFORT_LEVELS, type AgentRecord, type EffortLevel, type ModelOption } from './api';
import { CheckIcon, Chevron, ChevronDownIcon } from './icons';
import { agentRun, effortLevels, findModel, modelLabel, useModels } from './models';

type Props = {
  agent: AgentRecord;
  run: (a: () => Promise<unknown>) => Promise<void>;
};

/** The header chip `Sonnet 5.5 ▂▄▆ medium ⌄` and its popover for switching model and effort. */
export function ModelPicker({ agent, run }: Props) {
  const models = useModels();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { model, effort } = agentRun(agent);
  const levels = effortLevels(model);
  const label = modelLabel(model);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close, true);
    };
  }, [open]);

  const change = (c: { model?: string | null; effort?: EffortLevel | null }) => void run(() => commands.setModel(agent.id, c));

  return (
    <div className="menu-anchor" ref={ref}>
      <button
        className="chip mono model-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`${label}${levels.length ? ` · ${effort ?? 'default'} effort` : ''}\nModel and effort, from the next turn on`}
        onClick={() => setOpen(!open)}
      >
        <span className="model-chip-name">{label}</span>
        {levels.length > 0 && (
          <>
            <EffortBars effort={effort} />
            <span className="model-chip-effort">{effort ?? 'default'}</span>
          </>
        )}
        <ChevronDownIcon size={12} className="model-chip-chevron" aria-hidden="true" />
      </button>
      {open && <Popover agent={agent} models={models} model={model} effort={effort} levels={levels} onChange={change} />}
    </div>
  );
}

/** Five bars of rising height, filled up to the effort level. No level set: all bars empty. */
export function EffortBars({ effort }: { effort: EffortLevel | null }) {
  const n = effort ? EFFORT_LEVELS.indexOf(effort) + 1 : 0;
  return (
    <span className="effort-bars" aria-hidden="true">
      {EFFORT_LEVELS.map((l, i) => (
        <span key={l} className={i < n ? 'on' : undefined} style={{ height: 3 + i * 1.75 }} />
      ))}
    </span>
  );
}

function Popover({
  agent,
  models,
  model,
  effort,
  levels,
  onChange,
}: {
  agent: AgentRecord;
  models: ModelOption[] | null;
  model: string;
  effort: EffortLevel | null;
  levels: EffortLevel[];
  onChange: (c: { model?: string | null; effort?: EffortLevel | null }) => void;
}) {
  // The checked row: what the agent is set to, else the default (which an unset agent runs on).
  const checked = agent.model ? findModel(models, agent.model)?.value : 'default';
  const current = findModel(models, model);
  const main = models?.filter((m) => !m.value.startsWith('claude-')) ?? [];
  const older = models?.filter((m) => m.value.startsWith('claude-')) ?? [];
  const [showOlder, setShowOlder] = useState(older.some((m) => m.value === checked));
  const running = agent.status === 'running' && agent.activeModel;

  const row = (m: ModelOption) => (
    <button
      key={m.value}
      className={`model-option${m.value === checked ? ' checked' : ''}`}
      aria-pressed={m.value === checked}
      onClick={() => m.value !== checked && onChange({ model: m.value === 'default' ? null : m.value })}
    >
      <span className="model-option-text">
        <span className="model-option-name">{m.value === 'default' ? `Default · ${modelLabel('default')}` : m.displayName}</span>
        <span className="model-option-hint">{m.value === 'default' ? 'What Claude Code picks' : m.description}</span>
      </span>
      {m.value === checked && <CheckIcon size={15} />}
    </button>
  );

  return (
    <div className="model-popover" role="dialog" aria-label="Model and effort">
      <div className="model-section">Model</div>
      {!models && <div className="model-loading">Loading models…</div>}
      <div className="model-list">
        {main.map(row)}
        {older.length > 0 && (
          <>
            <button className="model-more" aria-expanded={showOlder} onClick={() => setShowOlder(!showOlder)}>
              <Chevron open={showOlder} size={13} />
              Other versions
            </button>
            {showOlder && older.map(row)}
          </>
        )}
      </div>
      <div className="model-section">Effort</div>
      {levels.length > 0 ? (
        <div className="segmented" role="radiogroup" aria-label="Effort" style={{ gridTemplateColumns: `repeat(${levels.length}, minmax(0, 1fr))` }}>
          {levels.map((l) => (
            <button key={l} role="radio" aria-checked={l === effort} className={l === effort ? 'on' : undefined} onClick={() => l !== effort && onChange({ effort: l })}>
              {l}
            </button>
          ))}
        </div>
      ) : (
        <div className="model-note">{current?.displayName ?? modelLabel(model)} has no effort levels.</div>
      )}
      <div className="model-note">
        {levels.length > 0 && !effort && "No effort set: the model's default applies. "}
        Changes apply from the next turn.
        {running && ` The running turn finishes on ${modelLabel(agent.activeModel!)}.`}
      </div>
    </div>
  );
}
