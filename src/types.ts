export type AgentKind = 'orchestrator' | 'expert';

export type AgentStatus =
  | 'idle' // waiting for a message
  | 'running' // a turn is in progress
  | 'error' // the last turn or the process failed
  | 'stopped' // stopped on purpose; the next message resumes it
  | 'interrupted'; // the manager restarted while a turn was running

export type MessageSource = 'user' | 'orchestrator' | 'manager';

export type QueuedMessage = {
  id: string;
  text: string;
  source: MessageSource;
  /** Notify the parent orchestrator when the turn handling this message ends. */
  notify: boolean;
  queuedAt: string;
};

export type Reply = {
  /** Final text of the turn. */
  text: string;
  at: string;
  isError: boolean;
  /** The user interrupted the turn (Esc). Not an error. */
  interrupted?: boolean;
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
  costUsd: number;
  /** Hidden in the tree's "Archived" group. Only experts can be archived. */
  archived: boolean;
  /** When a turn last ended or failed. The UI compares it with its own "last seen" time. */
  lastActivityAt: string;
  context: ContextUsage | null;
  createdAt: string;
  updatedAt: string;
};

export type StateFile = {
  version: 1;
  agents: AgentRecord[];
};
