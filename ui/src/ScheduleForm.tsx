import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { commands, type AgentRecord, type CommandOption, type EffortLevel, type ScheduledTask, type ScheduleSpec, type ScheduleTarget } from './api';
import { recentChatFolders, store } from './store';
import { folderName } from './status';
import { MenuIcon } from './icons';
import { effortLevels, useModels } from './models';
import { sameFolder, useServerInfo } from './hooks';

const when = (at: string) => new Date(at).toLocaleString();
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type Mode = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'once' | 'manual' | 'cron';
const modes: { value: Mode; label: string }[] = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'once', label: 'Once' },
  { value: 'manual', label: 'Manual' },
  { value: 'cron', label: 'Custom cron' },
];
const hourSteps = [1, 2, 3, 4, 6, 8, 12, 24];

const missedOptions: { value: ScheduledTask['missedRuns']; label: string; hint: string }[] = [
  { value: 'ask', label: 'Ask me', hint: 'You decide when you return' },
  { value: 'run', label: 'Run once', hint: 'Catch up with one run when the manager is back' },
  { value: 'skip', label: 'Skip', hint: 'Wait for the next scheduled time' },
];
const permissionOptions: { value: ScheduledTask['unattended']; label: string; hint: string }[] = [
  { value: 'deny', label: 'Deny and continue', hint: 'The run goes on without the tool it asked for' },
  { value: 'ask', label: 'Ask and wait', hint: 'The run pauses until you answer' },
];

function localInput(at: string): string {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** Which preset an existing schedule was made with (cron schedules without a label are custom). */
function modeOf(schedule: ScheduleSpec | undefined): Mode {
  if (!schedule) return 'daily';
  if (schedule.kind === 'manual') return 'manual';
  if (schedule.kind === 'once') return 'once';
  const label = schedule.label;
  if (!label) return 'cron';
  if (label.startsWith('Weekdays')) return 'weekdays';
  if (label.startsWith('Weekly')) return 'weekly';
  if (/^(Hourly|Every \d+ hour)/.test(label)) return 'hourly';
  return 'daily';
}

function timeOf(schedule: ScheduleSpec | undefined): string {
  if (schedule?.kind !== 'cron') return '09:00';
  const [minute, hour] = schedule.cron.split(' ');
  return /^\d+$/.test(hour) ? `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}` : '09:00';
}

function everyHoursOf(schedule: ScheduleSpec | undefined): number {
  if (schedule?.kind !== 'cron') return 1;
  const hour = schedule.cron.split(' ')[1];
  return hour.startsWith('*/') ? +hour.slice(2) : 1;
}

function daysOf(schedule: ScheduleSpec | undefined): number[] {
  if (schedule?.kind === 'cron' && schedule.label?.startsWith('Weekly')) return schedule.cron.split(' ')[4].split(',').map(Number);
  return [1];
}

type FormProps = {
  task?: ScheduledTask;
  agentId?: string;
  agents: Map<string, AgentRecord>;
  onSelect: (id: string) => void;
  onClose?: () => void;
  onOpenDrawer?: () => void;
};

export function ScheduleForm({ task, agentId, agents, onSelect, onClose, onOpenDrawer }: FormProps) {
  const [name, setName] = useState(task?.name ?? '');
  const [prompt, setPrompt] = useState(task?.prompt ?? '');
  const [targetKind, setTargetKind] = useState<'newChat' | 'agent'>(task?.target.kind ?? (agentId ? 'agent' : 'newChat'));
  const [targetId, setTargetId] = useState(task?.target.kind === 'agent' ? task.target.agentId : (agentId ?? ''));
  const [folder, setFolder] = useState(task?.target.kind === 'newChat' ? task.target.cwd : '');
  const [model, setModel] = useState(task?.target.kind === 'newChat' ? (task.target.model ?? '') : '');
  const [effort, setEffort] = useState(task?.target.kind === 'newChat' ? (task.target.effort ?? '') : '');
  const [mode, setMode] = useState<Mode>(() => modeOf(task?.schedule));
  const [time, setTime] = useState(() => timeOf(task?.schedule));
  const [everyHours, setEveryHours] = useState(() => everyHoursOf(task?.schedule));
  const [days, setDays] = useState<number[]>(() => daysOf(task?.schedule));
  const [cron, setCron] = useState(task?.schedule.kind === 'cron' ? task.schedule.cron : '0 9 * * *');
  const [once, setOnce] = useState(task?.schedule.kind === 'once' ? localInput(task.schedule.at) : '');
  const [missedRuns, setMissedRuns] = useState<ScheduledTask['missedRuns']>(task?.missedRuns ?? 'ask');
  const [unattended, setUnattended] = useState<ScheduledTask['unattended']>(task?.unattended ?? 'deny');
  const [keepRuns, setKeepRuns] = useState(task?.keepRuns ?? 5);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    void commands
      .info()
      .then((info) => {
        if (!folder) setFolder(info.orchestratorFolder);
        if (!task) setMissedRuns(info.scheduleMissedRuns);
      })
      .catch(() => {});
  }, []);

  const spec = (): ScheduleSpec => {
    if (mode === 'manual') return { kind: 'manual' };
    if (mode === 'once') return { kind: 'once', at: new Date(once).toISOString() };
    if (mode === 'cron') return { kind: 'cron', cron };
    const [hours, minutes] = time.split(':').map(Number);
    if (mode === 'hourly') {
      return { kind: 'cron', cron: `0 ${everyHours === 1 ? '*' : `*/${everyHours}`} * * *`, label: `Every ${everyHours} hour${everyHours === 1 ? '' : 's'}` };
    }
    const dayField = mode === 'weekdays' ? '1-5' : mode === 'weekly' ? days.join(',') : '*';
    const label = mode === 'weekly' ? `Weekly ${days.map((d) => weekdays[d]).join(', ')} ${time}` : `${mode[0].toUpperCase() + mode.slice(1)} ${time}`;
    return { kind: 'cron', cron: `${minutes} ${hours} * * ${dayField}`, label };
  };

  // What is missing, by field. Shown once the user tried to save or left the field.
  const problems = {
    name: name.trim() ? '' : 'Give the task a name.',
    prompt: prompt.trim() ? '' : 'Write the prompt it should run.',
    folder: targetKind === 'newChat' && !folder.trim() ? 'Choose the folder the chat runs in.' : '',
    agent: targetKind === 'agent' && !targetId ? 'Choose the agent that receives the prompt.' : '',
    once: mode === 'once' && (!once || Number.isNaN(new Date(once).getTime())) ? 'Pick the date and time.' : '',
    days: mode === 'weekly' && !days.length ? 'Pick at least one day.' : '',
    cron: mode === 'cron' && !cron.trim() ? 'Enter a cron expression.' : '',
  };
  const firstProblem = (Object.keys(problems) as (keyof typeof problems)[]).find((key) => problems[key]);
  const shown = (key: keyof typeof problems) => (submitted ? problems[key] : '');

  const save = async (e: FormEvent | null, paused = false) => {
    e?.preventDefault();
    if (busy) return;
    setSubmitted(true);
    setError('');
    if (firstProblem) {
      formRef.current?.querySelector<HTMLElement>(`[data-field="${firstProblem}"]`)?.focus();
      return;
    }
    setBusy(true);
    try {
      const target: ScheduleTarget =
        targetKind === 'agent' ? { kind: 'agent', agentId: targetId } : { kind: 'newChat', cwd: folder, model: model || null, effort: (effort || null) as EffortLevel | null };
      const input = { name, prompt, target, schedule: spec(), missedRuns, unattended, keepRuns };
      const saved = task ? await commands.updateSchedule(task.id, input) : await commands.createSchedule({ ...input, paused });
      store.upsertSchedule(saved);
      onSelect(`schedule:${saved.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form ref={formRef} className="schedule-view sf" noValidate aria-label={task ? 'Edit scheduled task' : 'New scheduled task'} onSubmit={(e) => void save(e)}>
      <header className="sf-head">
        {onOpenDrawer && (
          <button type="button" className="icon-button" onClick={onOpenDrawer} aria-label="Open sidebar">
            <MenuIcon size={16} />
          </button>
        )}
        <h2>{task ? `Edit · ${task.name}` : 'New scheduled task'}</h2>
        {onClose && (
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close pane">
            ×
          </button>
        )}
      </header>

      <div className="sf-body">
        <Section title="What" hint="The task's name and the prompt it sends on each run.">
          <Field label="Name" htmlFor="sf-name" error={shown('name')}>
            <input id="sf-name" data-field="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning triage" autoComplete="off" aria-invalid={!!shown('name')} />
          </Field>
          <PromptField
            value={prompt}
            onChange={setPrompt}
            folder={targetKind === 'agent' ? (agents.get(targetId)?.cwd ?? '') : folder}
            error={shown('prompt')}
          />
        </Section>

        <Section title="Where" hint="Who receives the prompt.">
          <Segmented
            label="Target"
            value={targetKind}
            onChange={setTargetKind}
            options={[
              { value: 'newChat', label: 'New chat each run' },
              { value: 'agent', label: 'Existing agent' },
            ]}
          />
          {targetKind === 'newChat' ? (
            <>
              <FolderField value={folder} onChange={setFolder} agents={agents} error={shown('folder')} />
              <ModelFields model={model} effort={effort} onModel={setModel} onEffort={setEffort} />
            </>
          ) : (
            <AgentField value={targetId} onChange={setTargetId} agents={agents} error={shown('agent')} />
          )}
        </Section>

        <Section title="When" hint="Times use this computer's local time.">
          <Segmented label="Schedule" value={mode} onChange={setMode} options={modes} wrap />
          <WhenFields
            mode={mode}
            time={time}
            onTime={setTime}
            everyHours={everyHours}
            onEveryHours={setEveryHours}
            days={days}
            onDays={setDays}
            cron={cron}
            onCron={setCron}
            once={once}
            onOnce={setOnce}
            errors={{ once: shown('once'), days: shown('days'), cron: shown('cron') }}
          />
          <NextRuns mode={mode} spec={spec} deps={[mode, time, everyHours, days.join(','), cron, once]} blocked={!!problems.once || !!problems.days || !!problems.cron} />
        </Section>

        <Section title="Options" hint="What happens when things don't go as planned.">
          <RadioRows legend="If a run was missed" name="missed" value={missedRuns} onChange={setMissedRuns} options={missedOptions} />
          <RadioRows legend="When a run needs permission" name="unattended" value={unattended} onChange={setUnattended} options={permissionOptions} />
          {targetKind === 'newChat' && (
            <Field label="Runs to keep" htmlFor="sf-keep" hint="Older finished run chats are archived automatically.">
              <input
                id="sf-keep"
                className="sf-number"
                type="number"
                min={0}
                max={50}
                value={keepRuns}
                onChange={(e) => setKeepRuns(Math.max(0, Math.min(50, +e.target.value || 0)))}
              />
            </Field>
          )}
        </Section>
      </div>

      <footer className="sf-footer">
        {error && (
          <p className="sf-error sf-footer-error" role="alert">
            {error}
          </p>
        )}
        {submitted && firstProblem && !error && (
          <p className="sf-error sf-footer-error" role="alert">
            Some fields need attention.
          </p>
        )}
        <div className="sf-actions">
          {onClose && (
            <button type="button" className="button secondary" onClick={onClose}>
              Cancel
            </button>
          )}
          {!task && (
            <button type="button" className="button secondary" disabled={busy} onClick={() => void save(null, true)}>
              Create paused
            </button>
          )}
          <button type="submit" className="button primary" disabled={busy}>
            {task ? 'Save' : 'Create'}
          </button>
        </div>
      </footer>
    </form>
  );
}

// ---------- building blocks ----------

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="sf-section">
      <div className="sf-section-head">
        <h3>{title}</h3>
        {hint && <p>{hint}</p>}
      </div>
      <div className="sf-section-body">{children}</div>
    </section>
  );
}

function Field({ label, htmlFor, hint, error, children }: { label: string; htmlFor: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div className="sf-field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? (
        <p className="sf-error" role="alert">
          {error}
        </p>
      ) : (
        hint && <p className="sf-hint">{hint}</p>
      )}
    </div>
  );
}

/** A segmented control: one radio group, arrow keys move the choice. */
function Segmented<T extends string>({ label, value, onChange, options, wrap }: { label: string; value: T; onChange: (value: T) => void; options: { value: T; label: string }[]; wrap?: boolean }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (e: KeyboardEvent, index: number) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div className={`sf-segmented${wrap ? ' wrap' : ''}`} role="radiogroup" aria-label={label}>
      {options.map((option, i) => (
        <button
          type="button"
          key={option.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          role="radio"
          aria-checked={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          className={option.value === value ? 'on' : ''}
          onClick={() => onChange(option.value)}
          onKeyDown={(e) => move(e, i)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Radio rows: a title and a one-line explanation each. */
function RadioRows<T extends string>({ legend, name, value, onChange, options }: { legend: string; name: string; value: T; onChange: (value: T) => void; options: { value: T; label: string; hint: string }[] }) {
  return (
    <fieldset className="sf-radios">
      <legend>{legend}</legend>
      {options.map((option) => (
        <label key={option.value} className={`sf-radio${option.value === value ? ' on' : ''}`}>
          <input type="radio" name={name} value={option.value} checked={option.value === value} onChange={() => onChange(option.value)} />
          <span className="sf-radio-text">
            <span className="sf-radio-label">{option.label}</span>
            <span className="sf-radio-hint">{option.hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

// ---------- prompt ----------

type Suggestion = { value: string; detail?: string };

/** The prompt box with the composer's `/` skill and `@` file menus, loaded for the target's folder. */
function PromptField({ value, onChange, folder, error }: { value: string; onChange: (value: string) => void; folder: string; error: string }) {
  const box = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [loaded, setLoaded] = useState<{ folder: string; kind: 'slash' | 'file'; values: Suggestion[] } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [index, setIndex] = useState(0);
  const [dismissedAt, setDismissedAt] = useState('');

  const beforeCaret = value.slice(0, caret);
  const slash = caret === value.length ? /^\/([^\s]*)$/.exec(beforeCaret) : null;
  const mention = /(^|\s)@([^\s@"]*)$/.exec(beforeCaret);
  const kind = slash ? 'slash' : mention ? 'file' : null;
  const query = slash?.[1] ?? mention?.[2] ?? '';
  const matching =
    kind && folder && loaded?.kind === kind && loaded.folder === folder && dismissedAt !== value
      ? loaded.values.filter((item) => item.value.toLowerCase().includes(query.toLowerCase())).slice(0, 10)
      : [];

  useEffect(() => {
    if (!kind || !folder) return;
    let live = true;
    setLoadError('');
    const load =
      kind === 'slash'
        ? commands.scheduleCommands(folder).then((list: CommandOption[]) => list.map((item) => ({ value: item.name, detail: item.description })))
        : commands.scheduleFiles(folder).then(({ files }) => {
            const dirs = new Set<string>();
            for (const file of files) {
              const parts = file.split('/');
              for (let n = 1; n < parts.length; n++) dirs.add(parts.slice(0, n).join('/'));
            }
            return [...dirs].map((dir) => ({ value: `${dir}/` })).concat(files.map((file) => ({ value: file })));
          });
    void load.then(
      (values) => {
        if (live) {
          setLoaded({ folder, kind, values });
          setIndex(0);
        }
      },
      (e: unknown) => {
        if (live) setLoadError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      live = false;
    };
  }, [kind, folder]);

  const place = (at: number) =>
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(at, at);
      setCaret(at);
    });

  const pick = (picked: string) => {
    if (slash) {
      const replacement = `/${picked} `;
      onChange(replacement + value.slice(caret));
      place(replacement.length);
    } else if (mention) {
      const start = mention.index + mention[1].length;
      const replacement = `@${/\s/.test(picked) ? `"${picked}"` : picked} `;
      onChange(value.slice(0, start) + replacement + value.slice(caret));
      place(start + replacement.length);
    }
    setLoaded(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!matching.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((n) => (n + (e.key === 'ArrowDown' ? 1 : -1) + matching.length) % matching.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pick(matching[Math.min(index, matching.length - 1)].value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDismissedAt(value);
    }
  };

  const active = Math.min(index, matching.length - 1);
  return (
    <div className="sf-field">
      <label htmlFor="sf-prompt">Prompt</label>
      <div className="sf-prompt">
        <textarea
          id="sf-prompt"
          data-field="prompt"
          ref={box}
          rows={6}
          value={value}
          placeholder="What should the agent do? Type / for skills and @ for files."
          aria-invalid={!!error}
          aria-controls={matching.length ? 'sf-suggestions' : undefined}
          aria-activedescendant={matching.length ? `sf-suggestion-${active}` : undefined}
          onChange={(e) => {
            onChange(e.target.value);
            setCaret(e.target.selectionStart);
            setIndex(0);
          }}
          onClick={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
        />
        {matching.length > 0 && (
          <div className="slash-menu" id="sf-suggestions" role="listbox" aria-label={kind === 'slash' ? 'Skills and commands' : 'Files and folders'}>
            {matching.map((item, i) => (
              <div
                key={item.value}
                id={`sf-suggestion-${i}`}
                role="option"
                aria-selected={i === active}
                className={`slash-item${i === active ? ' active' : ''}`}
                onMouseEnter={() => setIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(item.value);
                }}
              >
                <span className="slash-name mono">
                  {kind === 'slash' ? '/' : '@'}
                  {item.value}
                </span>
                {item.detail && <span className="slash-description">{item.detail}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
      {error ? (
        <p className="sf-error" role="alert">
          {error}
        </p>
      ) : kind && loadError ? (
        <p className="sf-error">{loadError}</p>
      ) : (
        <p className="sf-hint">Skills and files are looked up in the target's folder.</p>
      )}
    </div>
  );
}

// ---------- target ----------

function FolderField({ value, onChange, agents, error }: { value: string; onChange: (value: string) => void; agents: Map<string, AgentRecord>; error: string }) {
  const info = useServerInfo();
  const same = (a: string, b: string) => sameFolder(a, b, info?.platform);
  const defaultFolder = info?.orchestratorFolder ?? '';
  const choices = [...(defaultFolder ? [defaultFolder] : []), ...recentChatFolders(agents).filter((dir) => !defaultFolder || !same(dir, defaultFolder))].slice(0, 6);
  return (
    <div className="sf-field">
      <label htmlFor="sf-folder">Folder</label>
      <input
        id="sf-folder"
        data-field="folder"
        className="mono"
        value={value}
        placeholder="Absolute path"
        spellCheck={false}
        autoComplete="off"
        aria-invalid={!!error}
        onChange={(e) => onChange(e.target.value)}
      />
      {choices.length > 0 && (
        <div className="recent-folders sf-recents" role="listbox" aria-label="Recent folders">
          {choices.map((dir) => {
            const selected = same(dir, value.trim());
            return (
              <button type="button" key={dir} role="option" aria-selected={selected} className={`recent-folder${selected ? ' selected' : ''}`} title={dir} onClick={() => onChange(dir)}>
                <span className="recent-name">
                  {folderName(dir)}
                  {dir === defaultFolder ? ' (default)' : ''}
                </span>
                <span className="recent-path mono">{dir}</span>
              </button>
            );
          })}
        </div>
      )}
      {error && (
        <p className="sf-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ModelFields({ model, effort, onModel, onEffort }: { model: string; effort: string; onModel: (value: string) => void; onEffort: (value: string) => void }) {
  const models = useModels();
  const known = !model || models?.some((m) => m.value === model);
  const levels = effortLevels(model || 'default');
  return (
    <div className="sf-pair">
      <div className="sf-field">
        <label htmlFor="sf-model">Model</label>
        <select
          id="sf-model"
          value={model}
          onChange={(e) => {
            onModel(e.target.value);
            onEffort('');
          }}
        >
          <option value="">Default</option>
          {models
            ?.filter((m) => m.value !== 'default')
            .map((m) => (
              <option key={m.value} value={m.value}>
                {m.displayName}
              </option>
            ))}
          {!known && <option value={model}>{model}</option>}
        </select>
      </div>
      {levels.length > 0 && (
        <div className="sf-field">
          <span className="sf-label" id="sf-effort-label">
            Effort
          </span>
          <Segmented label="Effort" value={effort} onChange={onEffort} options={[{ value: '', label: 'Default' }, ...levels.map((level) => ({ value: level as string, label: level }))]} wrap />
        </div>
      )}
    </div>
  );
}

function AgentField({ value, onChange, agents, error }: { value: string; onChange: (value: string) => void; agents: Map<string, AgentRecord>; error: string }) {
  const options = [...agents.values()].filter((a) => !a.archived || a.id === value);
  return (
    <Field label="Agent" htmlFor="sf-agent" error={error} hint="The prompt is sent as a message to this agent on each run.">
      <select id="sf-agent" data-field="agent" value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error}>
        <option value="">Choose an agent</option>
        {options.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

// ---------- schedule ----------

type WhenProps = {
  mode: Mode;
  time: string;
  onTime: (value: string) => void;
  everyHours: number;
  onEveryHours: (value: number) => void;
  days: number[];
  onDays: (value: number[]) => void;
  cron: string;
  onCron: (value: string) => void;
  once: string;
  onOnce: (value: string) => void;
  errors: { once: string; days: string; cron: string };
};

function WhenFields({ mode, time, onTime, everyHours, onEveryHours, days, onDays, cron, onCron, once, onOnce, errors }: WhenProps) {
  const toggleDay = (day: number) => onDays(days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort());
  return (
    <>
      {mode === 'hourly' && (
        <Field label="Every" htmlFor="sf-hours">
          <select id="sf-hours" className="sf-short" value={everyHours} onChange={(e) => onEveryHours(+e.target.value)}>
            {hourSteps.map((n) => (
              <option key={n} value={n}>
                {n === 1 ? 'hour' : `${n} hours`}
              </option>
            ))}
          </select>
        </Field>
      )}
      {mode === 'weekly' && (
        <div className="sf-field">
          <span className="sf-label" id="sf-days-label">
            Days
          </span>
          <div className="sf-days" role="group" aria-labelledby="sf-days-label">
            {weekdays.map((day, i) => (
              <button type="button" key={day} data-field={i === 0 ? 'days' : undefined} className={`sf-chip${days.includes(i) ? ' on' : ''}`} aria-pressed={days.includes(i)} onClick={() => toggleDay(i)}>
                {day}
              </button>
            ))}
          </div>
          {errors.days && (
            <p className="sf-error" role="alert">
              {errors.days}
            </p>
          )}
        </div>
      )}
      {(mode === 'daily' || mode === 'weekdays' || mode === 'weekly') && (
        <Field label="At" htmlFor="sf-time">
          <input id="sf-time" className="sf-short" type="time" value={time} onChange={(e) => onTime(e.target.value || '09:00')} />
        </Field>
      )}
      {mode === 'once' && (
        <Field label="Run at" htmlFor="sf-once" error={errors.once}>
          <input id="sf-once" data-field="once" className="sf-datetime" type="datetime-local" value={once} onChange={(e) => onOnce(e.target.value)} aria-invalid={!!errors.once} />
        </Field>
      )}
      {mode === 'cron' && (
        <Field label="Cron expression" htmlFor="sf-cron" error={errors.cron} hint="Five fields: minute, hour, day of month, month, weekday. At least 15 minutes apart.">
          <input id="sf-cron" data-field="cron" className="mono" value={cron} spellCheck={false} onChange={(e) => onCron(e.target.value)} aria-invalid={!!errors.cron} />
        </Field>
      )}
      {mode === 'manual' && <p className="sf-hint">The task only runs when you press Run now.</p>}
    </>
  );
}

/** A live preview of the next runs, asked from the server (debounced), with its error inline. */
function NextRuns({ mode, spec, deps, blocked }: { mode: Mode; spec: () => ScheduleSpec; deps: unknown[]; blocked: boolean }) {
  const [times, setTimes] = useState<string[]>([]);
  const [error, setError] = useState('');
  const latest = useRef(spec);
  latest.current = spec;
  useEffect(() => {
    if (blocked) {
      setTimes([]);
      setError('');
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      try {
        void commands
          .schedulePreview(latest.current())
          .then((r) => {
            if (live) {
              setTimes(r.times);
              setError('');
            }
          })
          .catch((e: Error) => {
            if (live) setError(e.message);
          });
      } catch (e) {
        setError((e as Error).message);
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [...deps, blocked]);
  const empty = useMemo(() => (mode === 'manual' ? 'Runs only when you start it.' : blocked ? 'Complete the schedule to see the next runs.' : 'No upcoming runs.'), [mode, blocked]);
  return (
    <div className={`sf-next${error ? ' bad' : ''}`} aria-live="polite">
      <span className="sf-next-title">Next runs</span>
      {error ? (
        <span className="sf-next-error">{error}</span>
      ) : times.length && !blocked ? (
        <ol className="mono">
          {times.map((t) => (
            <li key={t}>{when(t)}</li>
          ))}
        </ol>
      ) : (
        <span className="sf-next-empty">{empty}</span>
      )}
    </div>
  );
}
