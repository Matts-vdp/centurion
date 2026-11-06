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

export type MessageSource = 'user' | 'orchestrator' | 'manager';

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
};

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
};

/** Context window use after the last turn. */
export type ContextUsage = {
  /** Input tokens of the last model call (including cache reads and writes). */
  usedTokens: number;
  windowTokens: number;
};

export type AgentRecord = {
  id: string;
  name: string;
  kind: AgentKind;
  /** Orchestrator that owns this expert; null for orchestrators. */
  parentId: string | null;
  cwd: string;
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
  /** Hidden in the tree's "Archived" group. Only experts can be archived. */
  archived: boolean;
  /** When a turn last ended or failed. The UI compares it with its own "last seen" time. */
  lastActivityAt: string;
  context: ContextUsage | null;
  /** Model chosen for this agent (alias or id); null uses `config.model` or Claude Code's default. */
  model: string | null;
  /** Effort chosen for this agent; null uses the model's default. */
  effort: EffortLevel | null;
  /** What the process last reported: the model of the last main-loop call and the effort from init. */
  activeModel: string | null;
  activeEffort: EffortLevel | null;
  createdAt: string;
  updatedAt: string;
};

// ---------- track plans (docs/ui-design.md, section 8) ----------

export type TrackTarget =
  | { kind: 'new_expert'; name: string; folder?: string }
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
  /** waiting: for the user. started: tracks are being or were started. */
  status: 'waiting' | 'started';
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
  /** open: some questions for the user are unanswered. */
  status: 'open' | 'answered';
  toolUseId?: string;
  createdAt: string;
  updatedAt: string;
};

export type StateFile = {
  version: 1;
  agents: AgentRecord[];
  plans?: Plan[];
  questionSets?: QuestionSet[];
};
