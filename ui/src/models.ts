import { useSyncExternalStore } from 'react';
import { commands, EFFORT_LEVELS, type AgentRecord, type EffortLevel, type ModelOption } from './api';

// The supported models, fetched once per page. Labels fall back to parsing the model id until they arrive.

let list: ModelOption[] | null = null;
let loading = false;
const listeners = new Set<() => void>();

function load(): void {
  if (list || loading) return;
  loading = true;
  commands
    .models()
    .then((models) => {
      list = models;
      for (const fn of listeners) fn();
    })
    .catch(() => {
      // try again on the next subscribe
    })
    .finally(() => (loading = false));
}

/** The models list (null until loaded). Components that show model labels call it to re-render on load. */
export function useModels(): ModelOption[] | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      load();
      return () => listeners.delete(fn);
    },
    () => list,
  );
}

/** The entry for an alias or id: an exact value first, then an entry that resolves to it. */
export function findModel(models: ModelOption[] | null, model: string): ModelOption | undefined {
  if (!models) return undefined;
  return (
    models.find((m) => m.value === model) ??
    models.find((m) => m.resolvedModel === model && m.value !== 'default') ??
    models.find((m) => m.resolvedModel === model)
  );
}

/** A short name for a model alias or id: `Sonnet 5.5`. "default" names the model it resolves to. */
export function modelLabel(model: string): string {
  const info = findModel(list, model);
  if (info?.value === 'default' && info.resolvedModel) {
    const named = findModel(list, info.resolvedModel);
    return named && named.value !== 'default' ? named.displayName : idLabel(info.resolvedModel);
  }
  return info?.displayName ?? idLabel(model);
}

function idLabel(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(model);
  if (m) return `${capitalise(m[1])} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
  return capitalise(model);
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * What an agent runs on: the model it is set to (what its next turn uses), else what it last ran on,
 * else the default. Effort is the one it is set to; null means the model's default.
 */
export function agentRun(a: AgentRecord): { model: string; effort: EffortLevel | null } {
  const model = a.model && a.model !== 'default' ? a.model : (a.activeModel ?? a.model ?? 'default');
  return { model, effort: a.effort ?? a.activeEffort };
}

/** `Sonnet 5.5 · medium`, for delegations, the round tracker and plans. */
export function runLabel(a: AgentRecord): string {
  const { model, effort } = agentRun(a);
  return [modelLabel(model), effort].filter(Boolean).join(' · ');
}

/** The effort levels a model supports; empty when it has none, all of them for a model not in the list. */
export function effortLevels(model: string): EffortLevel[] {
  const info = findModel(list, model);
  if (!info) return [...EFFORT_LEVELS];
  return info.supportsEffort ? (info.supportedEffortLevels ?? []) : [];
}
