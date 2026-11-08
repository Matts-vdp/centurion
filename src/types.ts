export type AgentKind = 'orchestrator' | 'expert';

export type AgentStatus =
  | 'idle' // waiting for a message
  | 'running' // a turn is in progress
  | 'error' // the last turn or the process failed
  | 'stopped' // stopped on purpose; the next message resumes it
  | 'interrupted'; // the manager restarted while a turn was running

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** A model the agents can run on, from the SDK's `supportedModels()`. */
export type ModelOption = {
  /** What to pass as `model`: an alias (`sonnet`) or a model id. `default` is Claude Code's default. */
  value: string;
  /** The model id the value resolves to. */
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: EffortLevel[];
};

/** A skill or custom command an agent's folder offers, from the SDK's `supportedCommands()`. */
export type CommandOption = { name: string; description: string; argumentHint: string };

export type MessageSource = 'user' | 'orchestrator' | 'manager' | 'schedule';

export type ScheduleSpec = { kind: 'cron'; cron: string; label?: string } | { kind: 'once'; at: string } | { kind: 'manual' };
export type ScheduleTarget = { kind: 'newChat'; cwd: string; model: string | null; effort: EffortLevel | null } | { kind: 'agent'; agentId: string };
export type ScheduledRun = {
  id: string; dueAt: string; trigger: 'schedule' | 'catchUp' | 'manual';
  status: 'pending' | 'waiting' | 'queued' | 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled' | 'skipped';
  reason?: string; missed?: number; agentId?: string; messageId?: string; promptUuid?: string;
  /** Run now was pressed; it may start even while automatic schedules are paused. */
  requested?: true;
  startedAt?: string; endedAt?: string; durationMs?: number; costUsd?: number; denied?: number; preview?: string;
};
export type ScheduledTask = {
  id: string; name: string; prompt: string; target: ScheduleTarget; schedule: ScheduleSpec;
  status: 'proposed' | 'active' | 'paused' | 'done'; missedRuns: 'run' | 'ask' | 'skip';
  unattended: 'deny' | 'ask'; keepRuns: number; nextAt: string | null; runs: ScheduledRun[];
  proposedBy?: { agentId: string; toolUseId?: string }; createdAt: string; updatedAt: string;
};

export type QueuedMessage = {
  id: string;
  text: string;
  source: MessageSource;
  /** Notify the parent orchestrator when the turn handling this message ends. */
  notify: boolean;
  queuedAt: string;
  /** The plan track this message starts or continues (create_expert / message_expert with track_id). */
  track?: { planId: string; trackId: string };
  /** The routed question this message asks (message_expert with question_id). */
  question?: { setId: string; questionId: string };
  schedule?: { taskId: string; runId: string };
  /** The uuid the session stores the prompt under, set on delivery. Fork and rewind cut at it. */
  uuid?: string;
  /** Images sent with the text: files in the uploads folder while queued, deleted on delivery. */
  images?: QueuedImage[];
};

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageMediaType = (typeof IMAGE_TYPES)[number];

/** An image of a queued message: its file name in the uploads folder. */
export type QueuedImage = { file: string; mediaType: ImageMediaType };

/** An image as the API takes it and the `delivered` event carries it. */
export type ImageData = { mediaType: ImageMediaType; data: string };

export type Reply = {
  /** Final text of the turn. */
  text: string;
  at: string;
  isError: boolean;
  /** The user interrupted the turn (Esc). Not an error. */
  interrupted?: boolean;
  /** How long the turn took, from delivery to its result. */
  durationMs?: number;
  /** What this turn cost. */
  costUsd?: number;
  scheduled?: true;
};

/** Context window use after the last turn. */
export type ContextUsage = {
  /** Input tokens of the last model call (including cache reads and writes). */
  usedTokens: number;
  windowTokens: number;
};

export type CacheState = { at: string; ttlSeconds: number };

/** Keeping the prompt cache warm between turns with cheap pings (src/keepwarm.ts). */
export type KeepWarmSettings = {
  /** Keep it warm for this many minutes after each turn; 0 = not by time. Capped by the cache's TTL. */
  minutes: number;
  /** Chats: keep it warm while any of its experts is working. */
  experts: boolean;
};

/**
 * The longest keep-warm episode after a turn, in minutes. A ping reads the context at about 0.1× the input
 * price, and writing a cold cache again costs 1.25× (5 minute TTL) or 2× (1 hour TTL), so pinging stops
 * paying after about 12 pings (45 minutes) or 20 pings (well past 8 hours).
 */
/** A queue entry held back by a notification pause. */
export function isHeld(rec: AgentRecord, m: QueuedMessage): boolean {
  return rec.notificationsPaused === true && m.source === 'manager';
}

/** Queue entries that will be delivered when the agent is free (held notifications left out). */
export function deliverable(rec: AgentRecord): QueuedMessage[] {
  return rec.queue.filter((m) => !isHeld(rec, m));
}

export function keepWarmCapMinutes(ttlSeconds: number): number {
  return ttlSeconds >= 3600 ? 480 : 45;
}

/** The durations the cache tag offers, in minutes. */
export function keepWarmChoices(ttlSeconds: number): number[] {
  return ttlSeconds >= 3600 ? [120, 240, 480] : [15, 30, 45];
}

/** What keep-warm is doing. Pings and cost count since the agent's last turn. */
export type KeepWarmState = {
  /** When the next ping is due; null when none is planned. */
  nextAt: string | null;
  /** The latest time keep-warm pings for this episode (the window or the cap); null when off. */
  until: string | null;
  /** Why pinging stopped until the next turn (the cache missed, a ping failed, the cache went cold). */
  stopped?: string;
  pings: number;
  costUsd: number;
  last?: KeepWarmPing;
};

export type KeepWarmPing = {
  at: string;
  /** Tokens the ping read from the cache, and how many it expected to (the last turn's context). */
  readTokens: number;
  expectedTokens: number;
  costUsd: number;
  ok: boolean;
  error?: string;
};

export type AgentRecord = {
  id: string;
  name: string;
  kind: AgentKind;
  /** Orchestrator that owns this expert; null for orchestrators. */
  parentId: string | null;
  scheduleId?: string;
  cwd: string;
  /**
   * Experts only: the folder of the expert's task, inside its orchestrator's folder. When set, it is the only
   * part of the orchestrator's folder the expert may read and write (file tools, outside its own folder);
   * absent = the whole orchestrator folder.
   */
  taskFolder?: string;
  /** Claude session ID, set after the first turn starts. Used to resume and to read history. */
  sessionId: string | null;
  status: AgentStatus;
  lastError: string | null;
  queue: QueuedMessage[];
  /** Last few final replies, newest last. Kept so get_expert_output is cheap. */
  replies: Reply[];
  /** Message currently being handled (removed from queue when delivered). */
  current: QueuedMessage | null;
  /** When the current turn started (the message was delivered); null between turns. */
  turnStartedAt: string | null;
  costUsd: number;
  /** Out of sight in an "Archived" group. A new message brings it back. */
  archived: boolean;
  /** The chat this expert was archived with; unarchiving that chat brings it back too. */
  archivedWith: string | null;
  /** When a turn last ended or failed. The UI compares it with its own "last seen" time. */
  lastActivityAt: string;
  context: ContextUsage | null;
  /**
   * The prompt cache after the last turn (an estimate): when its last main-loop request started and the
   * cache's time to live. Every request that reads the cache restarts the timer. Null: unknown or reset.
   */
  cache?: CacheState | null;
  /** Keep-warm settings; null or absent = off. */
  keepWarm?: KeepWarmSettings | null;
  /** What keep-warm is doing now. */
  warm?: KeepWarmState | null;
  /**
   * Chats only: expert notifications (manager messages) stay in the queue and the user's messages go
   * first. Resuming merges the held ones into one message. Absent = false.
   */
  notificationsPaused?: boolean;
  /** Model chosen for this agent (alias or id); null uses `config.model` or Claude Code's default. */
  model: string | null;
  /** Effort chosen for this agent; null uses the model's default. */
  effort: EffortLevel | null;
  /** What the process last reported: the model of the last main-loop call and the effort from init. */
  activeModel: string | null;
  activeEffort: EffortLevel | null;
  /** The agent this one was forked from. */
  forkedFrom?: string;
  createdAt: string;
  updatedAt: string;
};

// ---------- permission prompts (docs/next-plan.md, part 3) ----------

/** A tool call auto mode couldn't decide on, waiting for the user. Kept in memory only. */
export type PermissionRequest = {
  id: string;
  agentId: string;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  /** The SDK's prompt sentence, e.g. "Claude wants to read foo.txt". */
  title?: string;
  description?: string;
  /** Why it was asked. */
  reason?: string;
  blockedPath?: string;
  /** "Allow for this session" is offered (the SDK suggested rules and didn't forbid it). */
  canAllowSession: boolean;
  /** Start on Deny; no one-key approve. */
  defaultToNo: boolean;
  status: 'pending' | 'allowed' | 'allowedSession' | 'denied' | 'cancelled';
  /** The user's note with a denial. */
  message?: string;
  createdAt: string;
  answeredAt?: string;
};

export type PermissionDecision = 'allow' | 'allowSession' | 'deny';

// ---------- track plans (docs/ui-design.md, section 8) ----------

export type TrackTarget =
  | { kind: 'new_expert'; name: string; folder?: string; taskFolder?: string }
  | { kind: 'existing_expert'; expertId: string }
  | { kind: 'subagent' };

export type Track = {
  id: string;
  title: string;
  /** One or two sentences for the user to decide on. The real instructions are the handoff prompt. */
  summary: string;
  target: TrackTarget;
  model?: string;
  effort?: EffortLevel;
};

/** An outline of a later round: information only, it can't be started. */
export type LaterRound = { round: number; title: string; tracks: { title: string; summary?: string }[] };

export type PlanVersion = {
  version: number;
  title: string;
  tracks: Track[];
  later: LaterRound[];
  proposedAt: string;
  /** The propose_tracks call that made this version. */
  toolUseId?: string;
};

export type Plan = {
  id: string;
  orchestratorId: string;
  round: number;
  /** Oldest first; the last one is current. */
  versions: PlanVersion[];
  /** waiting: for the user. started: tracks are being or were started. dropped: rewound away before Start. */
  status: 'waiting' | 'started' | 'dropped';
  startedAt: string | null;
  /** The user's choice from Start (absent when the plan was started from the chat). */
  chosen: string[] | null;
  skipped: string[] | null;
  /** trackId → expert id, from create_expert / message_expert with track_id. */
  experts: Record<string, string>;
  /** trackId → when its expert's turn for the track ended. */
  replied: Record<string, string>;
  /** round: one combined notification when every started track has replied. each: one per reply. */
  notify: 'round' | 'each';
  /** Notifications held back until the round is complete. */
  held: string[];
  createdAt: string;
  updatedAt: string;
};

// ---------- question sets (docs/ui-design.md, section 9) ----------

export type QuestionOption = { label: string; detail?: string; suggested?: boolean };

export type Answer = { choices: string[]; text: string; at: string };

export type UserQuestion = {
  id: string;
  /** The expert that raised it, if any. */
  from?: string;
  question: string;
  context?: string;
  kind: 'single' | 'multi' | 'text';
  options: QuestionOption[];
  answer?: Answer;
};

export type ResolvedQuestion = {
  id: string;
  from?: string;
  question: string;
  answer: string;
  source?: string;
  /** The user corrected the orchestrator's answer. */
  correction?: { text: string; at: string };
};

export type RoutedQuestion = {
  id: string;
  from?: string;
  question: string;
  expertId: string;
  /** The expert's reply to the routed message. */
  answer?: { text: string; at: string };
};

export type QuestionSet = {
  id: string;
  orchestratorId: string;
  title: string;
  questions: UserQuestion[];
  resolved: ResolvedQuestion[];
  routed: RoutedQuestion[];
  /**
   * open: some questions for the user are unanswered. answered: all are. chat: the user replied in the
   * chat while it was open (it stops waiting but can still be answered). dropped: rewound away while open.
   */
  status: 'open' | 'answered' | 'chat' | 'dropped';
  toolUseId?: string;
  createdAt: string;
  updatedAt: string;
};

export type StateFile = {
  version: 2;
  agents: AgentRecord[];
  plans?: Plan[];
  questionSets?: QuestionSet[];
  schedules: ScheduledTask[];
  schedulesPaused?: boolean;
};
