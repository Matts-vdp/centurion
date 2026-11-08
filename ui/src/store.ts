import { useSyncExternalStore } from 'react';
import { eventsUrl, type AgentRecord, type ImageData, type LiveMessage, type PermissionRequest, type Plan, type QuestionSet, type QueuedMessage } from './api';
import { toolDetail } from './tools';

export type LiveEvent =
  | { kind: 'message'; agentId: string; message: LiveMessage }
  /** `images`: sent with the message, carried once by the event (history has them afterwards). */
  | { kind: 'delivered'; agentId: string; message: QueuedMessage; images?: ImageData[] };

export type GitEvent = { repo: string; agentIds: string[] };

/** What a running agent is doing right now, from the live stream (not persisted). */
export type Activity = {
  tool: { id: string; name: string; detail: string; since: number } | null;
};

type State = {
  agents: Map<string, AgentRecord>;
  /** agentId → live activity, for status lines everywhere. */
  activity: Map<string, Activity>;
  /** Track plans and question sets by id (sent after the snapshot, then on every change). */
  plans: Map<string, Plan>;
  questionSets: Map<string, QuestionSet>;
  /** Permission requests by id: pending ones and recently answered ones (for the outcome line). */
  permissions: Map<string, PermissionRequest>;
  connected: boolean;
  /** Bumped on every snapshot, i.e. on every (re)connect. The open transcript reloads its history then. */
  epoch: number;
  /** Set when the server refused the token. */
  authError: boolean;
};

/** The agent registry fed by the manager's SSE stream, plus a channel for transcript events. */
class ManagerStore {
  private state: State = { agents: new Map(), activity: new Map(), plans: new Map(), questionSets: new Map(), permissions: new Map(), connected: false, epoch: 0, authError: false };
  private readonly listeners = new Set<() => void>();
  private readonly liveListeners = new Set<(e: LiveEvent) => void>();
  private source: EventSource | null = null;
  private retry: number | null = null;

  getState = () => this.state;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private readonly gitListeners = new Set<(e: GitEvent) => void>();
  /** A git write in a repository (`repo`: its top folder; `agentIds`: the agents with a root in it). */
  onGit(fn: (e: GitEvent) => void): () => void {
    this.gitListeners.add(fn);
    return () => this.gitListeners.delete(fn);
  }

  onLive(fn: (e: LiveEvent) => void): () => void {
    this.liveListeners.add(fn);
    return () => this.liveListeners.delete(fn);
  }

  /** Apply a record returned by a command right away, without waiting for its SSE event. */
  upsert(rec: AgentRecord): void {
    const agents = new Map(this.state.agents);
    agents.set(rec.id, rec);
    this.set({ agents });
  }

  upsertPlan(plan: Plan): void {
    const plans = new Map(this.state.plans);
    plans.set(plan.id, plan);
    this.set({ plans });
  }

  upsertQuestions(set: QuestionSet): void {
    const questionSets = new Map(this.state.questionSets);
    questionSets.set(set.id, set);
    this.set({ questionSets });
  }

  upsertPermission(request: PermissionRequest): void {
    const permissions = new Map(this.state.permissions);
    permissions.set(request.id, request);
    this.set({ permissions });
  }

  connect(): void {
    if (this.source) return;
    const es = new EventSource(eventsUrl());
    this.source = es;
    es.addEventListener('snapshot', (e) => {
      const list = JSON.parse((e as MessageEvent).data) as AgentRecord[];
      this.set({
        agents: new Map(list.map((a) => [a.id, a])),
        plans: new Map(),
        questionSets: new Map(),
        permissions: new Map(),
        connected: true,
        authError: false,
        epoch: this.state.epoch + 1,
      });
    });
    es.addEventListener('agent', (e) => {
      const rec = JSON.parse((e as MessageEvent).data) as AgentRecord;
      if (rec.status !== 'running') this.setActivity(rec.id, { tool: null });
      this.upsert(rec);
    });
    es.addEventListener('plan', (e) => this.upsertPlan(JSON.parse((e as MessageEvent).data) as Plan));
    es.addEventListener('questions', (e) => this.upsertQuestions(JSON.parse((e as MessageEvent).data) as QuestionSet));
    es.addEventListener('permission', (e) => this.upsertPermission(JSON.parse((e as MessageEvent).data) as PermissionRequest));
    es.addEventListener('git', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as GitEvent;
      for (const fn of this.gitListeners) fn(d);
    });
    es.addEventListener('message', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { agentId: string; message: LiveMessage };
      this.track(d.agentId, d.message);
      this.emitLive({ kind: 'message', ...d });
    });
    es.addEventListener('delivered', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { agentId: string; message: QueuedMessage; images?: ImageData[] };
      this.setActivity(d.agentId, { tool: null });
      this.emitLive({ kind: 'delivered', ...d });
    });
    es.onerror = () => {
      if (this.state.connected) this.set({ connected: false });
      if (es.readyState === EventSource.CLOSED) {
        // The browser gave up (e.g. 401 or the server is down); check why and try again.
        this.source = null;
        void fetch(eventsUrl(), { method: 'HEAD' })
          .then((r) => this.set({ authError: r.status === 401 }))
          .catch(() => {});
        if (this.retry === null) {
          this.retry = window.setTimeout(() => {
            this.retry = null;
            this.connect();
          }, 2000);
        }
      }
    };
  }

  /** Follow the running tool of each agent: set on tool_use, cleared by its tool_result. */
  private track(agentId: string, m: LiveMessage): void {
    if (m.parent_tool_use_id) return;
    const content = (m.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return;
    const blocks = content as { type: string; id?: string; name?: string; input?: unknown; tool_use_id?: string }[];
    if (m.type === 'assistant') {
      const use = blocks.filter((b) => b.type === 'tool_use').at(-1);
      if (use) {
        const input = (use.input ?? {}) as Record<string, unknown>;
        const name = String(use.name);
        this.setActivity(agentId, { tool: { id: String(use.id), name, detail: toolDetail(name, input), since: Date.now() } });
      }
    } else if (m.type === 'user') {
      const current = this.state.activity.get(agentId)?.tool;
      if (current && blocks.some((b) => b.type === 'tool_result' && b.tool_use_id === current.id)) {
        this.setActivity(agentId, { tool: null });
      }
    }
  }

  private setActivity(agentId: string, a: Activity): void {
    const prev = this.state.activity.get(agentId);
    if (!prev?.tool && !a.tool) return;
    const activity = new Map(this.state.activity);
    activity.set(agentId, a);
    this.set({ activity });
  }

  private emitLive(e: LiveEvent): void {
    for (const fn of this.liveListeners) fn(e);
  }

  private set(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }
}

export const store = new ManagerStore();

export function useManager(): State {
  return useSyncExternalStore(store.subscribe, store.getState);
}

// ---------- per-browser view state (localStorage, best effort) ----------

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage blocked or full: the view state just isn't remembered
  }
}

/** A small persisted record store with React bindings. */
class PersistedMap<V> {
  private value: Record<string, V>;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly key: string) {
    this.value = readJson<Record<string, V>>(key, {});
  }

  get = () => this.value;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  set(id: string, v: V): void {
    if (this.value[id] === v) return;
    this.value = { ...this.value, [id]: v };
    writeJson(this.key, this.value);
    for (const fn of this.listeners) fn();
  }

  use(): Record<string, V> {
    return useSyncExternalStore(this.subscribe, this.get);
  }
}

/** A tiny shared value with React bindings, not persisted. */
class Signal<V> {
  private readonly listeners = new Set<() => void>();
  constructor(private value: V) {}
  get = () => this.value;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  set(v: V): void {
    if (this.value === v) return;
    this.value = v;
    for (const fn of this.listeners) fn();
  }
  use(): V {
    return useSyncExternalStore(this.subscribe, this.get);
  }
}

/** Text to put into an agent's composer (a rewound message goes back there to edit and resend). */
export const composerFill = new Signal<{ agentId: string; text: string } | null>(null);

/** The chat whose New expert form is open in the sidebar (the header menu opens it too). */
export const newExpertFor = new Signal<string | null>(null);

/** Folders experts have used, newest first, then the managing folder. */
export function recentFolders(agents: Map<string, AgentRecord>): string[] {
  const list = [...agents.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (dir: string) => {
    const key = dir.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(dir);
  };
  for (const a of list) if (a.kind === 'expert') add(a.cwd);
  for (const a of list) if (a.kind === 'orchestrator') add(a.cwd);
  return out;
}

/** agentId → the lastActivityAt the user has seen. */
export const lastSeen = new PersistedMap<string>('centurion-last-seen');
/** orchestratorId → collapsed in the tree; `archived:<id>` → archived group expanded. */
export const treeState = new PersistedMap<boolean>('centurion-tree');

/** Open the New expert form under a chat, with the chat expanded in the tree. */
export function openNewExpert(chatId: string): void {
  treeState.set(chatId, false);
  newExpertFor.set(chatId);
}

export function isUnread(a: AgentRecord, seen: Record<string, string>): boolean {
  const since = seen[a.id] ?? a.createdAt;
  return a.status !== 'running' && Date.parse(a.lastActivityAt) > Date.parse(since);
}
/** View preferences: `verbose` (Ctrl+O, every work log open). */
export const viewPrefs = new PersistedMap<boolean>('centurion-view');

/** An agent's permission requests that wait for the user, oldest first. */
export function pendingPermissions(agentId: string, state: Pick<State, 'permissions'> = store.getState()): PermissionRequest[] {
  return [...state.permissions.values()].filter((p) => p.agentId === agentId && p.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The answered request for a tool call, if the user was asked about it. */
export function permissionFor(toolUseId: string, state: Pick<State, 'permissions'> = store.getState()): PermissionRequest | undefined {
  for (const p of state.permissions.values()) if (p.toolUseId === toolUseId) return p;
  return undefined;
}

/** What an orchestrator is waiting on the user for: a plan to start and open questions. */
export function pendingFor(agentId: string, state: Pick<State, 'plans' | 'questionSets'> = store.getState()) {
  const plan = [...state.plans.values()].filter((p) => p.orchestratorId === agentId && p.status === 'waiting').at(-1) ?? null;
  const sets = [...state.questionSets.values()].filter((q) => q.orchestratorId === agentId && q.status === 'open');
  const questions = sets.reduce((n, q) => n + q.questions.filter((x) => !x.answer).length, 0);
  return { plan, questions };
}
