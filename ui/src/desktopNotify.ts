// Desktop alerts: system notifications (the Web Notifications API) while the window is hidden or
// unfocused, when a chat's turn ends or an agent needs you. Not to be confused with a chat's paused
// "expert notifications", which are manager messages in its queue.
//
// The parts are kept apart so a service worker can reuse them later: `AlertWatcher` turns store
// states into alert events (no DOM), `alertsOn` reads the settings, and `showAlert` is the only part
// that touches the Notification API (a worker would call `registration.showNotification` instead).
import { useEffect, useSyncExternalStore } from 'react';
import type { AgentRecord, PermissionRequest, Plan, QuestionSet } from './api';

/** Per browser: it is about this device. `agents` overrides the defaults per agent. */
export type AlertSettings = { chats: boolean; experts: boolean; agents: Record<string, boolean> };

export type AlertEvent = {
  /** Unique per thing to alert about: the same key never alerts twice. */
  key: string;
  agentId: string;
  kind: 'turn' | 'permission' | 'plan' | 'questions';
  title: string;
  body: string;
};

/** The parts of the store's state the watcher reads. */
export type AlertSource = {
  agents: Map<string, AgentRecord>;
  plans: Map<string, Plan>;
  questionSets: Map<string, QuestionSet>;
  permissions: Map<string, PermissionRequest>;
  epoch: number;
};

// ---------- settings ----------

const KEY = 'centurion-desktop-alerts';
const DEFAULTS: AlertSettings = { chats: true, experts: false, agents: {} };

function read(): AlertSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AlertSettings>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

let settings = read();
const listeners = new Set<() => void>();

function save(next: AlertSettings): void {
  settings = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage blocked: the setting lasts until reload
  }
  for (const fn of listeners) fn();
}

export function getAlertSettings(): AlertSettings {
  return settings;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useAlertSettings(): AlertSettings {
  return useSyncExternalStore(subscribe, getAlertSettings);
}

/** The default for an agent's kind: chats (top-level) or experts. */
export function alertDefault(a: Pick<AgentRecord, 'parentId'>, s: AlertSettings = settings): boolean {
  return a.parentId === null ? s.chats : s.experts;
}

/** Whether this agent's alerts are on (its own toggle, else the default for its kind). */
export function alertsOn(a: Pick<AgentRecord, 'id' | 'parentId'>, s: AlertSettings = settings): boolean {
  return s.agents[a.id] ?? alertDefault(a, s);
}

/** Turning something on asks the browser for permission the first time. */
export function setAlertDefault(kind: 'chats' | 'experts', on: boolean): void {
  save({ ...settings, [kind]: on });
  if (on) void askPermission();
}

/** Sets an agent's own toggle; back to the default when it matches the default. */
export function setAgentAlerts(a: Pick<AgentRecord, 'id' | 'parentId'>, on: boolean): void {
  const agents = { ...settings.agents };
  if (on === alertDefault(a)) delete agents[a.id];
  else agents[a.id] = on;
  save({ ...settings, agents });
  if (on) void askPermission();
}

// ---------- permission ----------

export type AlertPermission = NotificationPermission | 'unsupported';

export function alertPermission(): AlertPermission {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

/** Asks the browser for permission (only while it hasn't been asked). Call it from a click. */
export async function askPermission(): Promise<void> {
  if (alertPermission() !== 'default') return;
  try {
    await Notification.requestPermission();
  } catch {
    // old browsers: the callback form, or none
  }
  for (const fn of listeners) fn();
}

/** The browser's permission, re-rendered after a request. */
export function useAlertPermission(): AlertPermission {
  useAlertSettings();
  return alertPermission();
}

// ---------- events ----------

/** States that end a turn and are worth an alert; `stopped` is always the user's doing. */
function turnLine(a: AgentRecord): string | null {
  if (a.status === 'error') return `Failed: ${firstLine(a.lastError ?? 'the turn failed')}`;
  if (a.status !== 'idle') return null;
  const reply = a.replies.at(-1);
  if (reply?.interrupted) return null;
  return reply?.text.trim() ? firstLine(reply.text) : 'Finished its turn';
}

function firstLine(text: string): string {
  const line = text.trim().split('\n').find((l) => l.trim()) ?? '';
  const plain = line.replace(/^#+\s*|[*_`]/g, '').trim();
  return plain.length > 140 ? `${plain.slice(0, 139)}…` : plain;
}

/** Events from the initial snapshot, and the plans and requests that follow it, don't alert. */
const SETTLE_MS = 1500;

/**
 * Turns successive store states into alert events. Every alertable thing gets a key; keys are
 * remembered whether or not they alerted, so nothing alerts twice and turning a toggle on later
 * doesn't bring up old things.
 */
export class AlertWatcher {
  private readonly seen = new Set<string>();
  private prev: AlertSource | null = null;
  private quietUntil = 0;

  /** The events to show for `next`; `now` and `wanted` (toggles, focus) come from the caller. */
  update(next: AlertSource, now: number, wanted: (a: AgentRecord) => boolean): AlertEvent[] {
    const prev = this.prev;
    this.prev = next;
    if (!prev || prev.epoch !== next.epoch) this.quietUntil = now + SETTLE_MS;
    const quiet = now < this.quietUntil;
    const out: AlertEvent[] = [];
    const add = (e: AlertEvent) => {
      if (this.seen.has(e.key)) return;
      this.seen.add(e.key);
      const a = next.agents.get(e.agentId);
      if (!quiet && a && !a.archived && wanted(a)) out.push(e);
    };

    // A turn ends: running before, not running now (on the same connection).
    if (prev && prev.epoch === next.epoch && prev.agents !== next.agents) {
      for (const a of next.agents.values()) {
        if (prev.agents.get(a.id)?.status !== 'running' || a.status === 'running') continue;
        const body = turnLine(a);
        if (body) add({ key: `turn:${a.id}:${a.lastActivityAt}`, agentId: a.id, kind: 'turn', title: a.name, body });
      }
    }
    for (const p of next.permissions.values()) {
      if (p.status !== 'pending') continue;
      const name = next.agents.get(p.agentId)?.name ?? 'An agent';
      add({ key: `permission:${p.id}`, agentId: p.agentId, kind: 'permission', title: name, body: p.title ?? `Wants to use ${p.toolName}` });
    }
    for (const plan of next.plans.values()) {
      if (plan.status !== 'waiting') continue;
      const tracks = plan.versions.at(-1)?.tracks.length ?? 0;
      add({
        key: `plan:${plan.id}:${plan.versions.length}`,
        agentId: plan.orchestratorId,
        kind: 'plan',
        title: next.agents.get(plan.orchestratorId)?.name ?? 'A chat',
        body: `Round ${plan.round} is ready to start: ${tracks} track${tracks === 1 ? '' : 's'}`,
      });
    }
    for (const set of next.questionSets.values()) {
      if (set.status !== 'open') continue;
      const open = set.questions.filter((q) => !q.answer).length;
      add({
        key: `questions:${set.id}`,
        agentId: set.orchestratorId,
        kind: 'questions',
        title: next.agents.get(set.orchestratorId)?.name ?? 'A chat',
        body: `${open} question${open === 1 ? '' : 's'} for you: ${set.title}`,
      });
    }
    return out;
  }
}

// ---------- showing ----------

/** The window can't be seen or doesn't have the focus: the only time alerts go out. */
export function windowAway(): boolean {
  return document.visibilityState === 'hidden' || !document.hasFocus();
}

/** Shows one alert; a click focuses the window and calls `onOpen`. One alert per agent and kind at a time. */
export function showAlert(e: AlertEvent, onOpen: (agentId: string) => void): void {
  if (alertPermission() !== 'granted') return;
  try {
    const n = new Notification(e.title, { body: e.body, tag: `centurion:${e.agentId}:${e.kind}`, icon: '/favicon.svg' });
    n.onclick = () => {
      window.focus();
      onOpen(e.agentId);
      n.close();
    };
  } catch {
    // Some mobile browsers only allow notifications from a service worker.
  }
}

/** Watches the store while the app runs and shows alerts; `onOpen` opens an agent. */
export function useDesktopAlerts(state: AlertSource, onOpen: (agentId: string) => void): void {
  useEffect(() => {
    const events = watcher.update(state, Date.now(), (a) => alertsOn(a) && windowAway());
    for (const e of events) showAlert(e, onOpen);
  }, [state.agents, state.plans, state.questionSets, state.permissions, state.epoch]);
}

const watcher = new AlertWatcher();
