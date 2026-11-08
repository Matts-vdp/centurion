import type {
  AgentRecord,
  CommandOption,
  EffortLevel,
  ImageData,
  ModelOption,
  PermissionDecision,
  PermissionRequest,
  Plan,
  QuestionSet,
  ScheduledTask,
  ScheduledRun,
  ScheduleSpec,
  ScheduleTarget,
  QueuedMessage,
  Track,
  UserQuestion,
} from '../../src/types';

export type { AgentRecord, CommandOption, EffortLevel, ImageData, ModelOption, PermissionDecision, PermissionRequest, Plan, QuestionSet, ScheduledTask, ScheduledRun, ScheduleSpec, ScheduleTarget, QueuedMessage, Track, UserQuestion };

export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export type AnswerPayload = { questionId: string; choices: string[]; text: string };

/** The token arrives once as ?token= and is kept for the browser tab. */
function loadToken(): string {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get('token');
  if (fromUrl !== null) {
    try {
      sessionStorage.setItem('centurion-token', fromUrl);
    } catch {
      return fromUrl; // storage blocked: keep the token in the URL so a reload still works
    }
    params.delete('token');
    const query = params.toString();
    history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
    return fromUrl;
  }
  try {
    return sessionStorage.getItem('centurion-token') ?? '';
  } catch {
    return '';
  }
}

export const token = loadToken();

/** A failed request: the server's sentence as the message, its whole JSON body as `data` (git errors add `details` and `commands`). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: Record<string, unknown>,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? res.statusText, res.status, data as Record<string, unknown>);
  return data as T;
}

export const eventsUrl = () => `/api/events?token=${encodeURIComponent(token)}`;

/** A message from Claude's session file (`/history`). */
export type HistoryMessage = {
  type: 'user' | 'assistant' | 'system';
  uuid: string;
  message: unknown;
  parent_tool_use_id: string | null;
};

/** The subset of SDK messages the manager forwards over SSE. Kept loose on purpose. */
export type LiveMessage = {
  type: string;
  subtype?: string;
  uuid?: string;
  message?: unknown;
  parent_tool_use_id?: string | null;
  [key: string]: unknown;
};

export type ServerInfo = { orchestratorFolder: string; permissionMode: string; platform: string; defaultModel: string | null; scheduleMissedRuns: ScheduledTask['missedRuns'] };

/** `/api/info` doesn't change while the server runs, so it is fetched once (again after a failure). */
let infoCache: Promise<ServerInfo> | null = null;
const fetchInfo = () =>
  api<ServerInfo>('/api/info').catch((err) => {
    infoCache = null;
    throw err;
  });

export const commands = {
  schedulePreview: (spec: ScheduleSpec) => spec.kind === 'manual' ? Promise.resolve({ times: [] as string[] }) :
    api<{ times: string[] }>(`/api/schedules/preview?${spec.kind === 'cron' ? `cron=${encodeURIComponent(spec.cron)}` : `once=${encodeURIComponent(spec.at)}`}`),
  scheduleCommands: (cwd: string) => api<CommandOption[]>(`/api/schedules/commands?cwd=${encodeURIComponent(cwd)}`),
  scheduleFiles: (cwd: string) => api<{ files: string[]; truncated: boolean }>(`/api/schedules/files?cwd=${encodeURIComponent(cwd)}`),
  createSchedule: (input: { name: string; prompt: string; target: ScheduleTarget; schedule: ScheduleSpec; missedRuns: ScheduledTask['missedRuns']; unattended: ScheduledTask['unattended']; keepRuns: number; paused?: boolean }) =>
    api<ScheduledTask>('/api/schedules', { method: 'POST', body: input }),
  updateSchedule: (id: string, input: Partial<ScheduledTask>) => api<ScheduledTask>(`/api/schedules/${id}`, { method: 'POST', body: input }),
  pauseSchedule: (id: string, paused: boolean) => api<ScheduledTask>(`/api/schedules/${id}/pause`, { method: 'POST', body: { paused } }),
  activateSchedule: (id: string) => api<ScheduledTask>(`/api/schedules/${id}/activate`, { method: 'POST' }),
  runSchedule: (id: string) => api<ScheduledRun>(`/api/schedules/${id}/run`, { method: 'POST' }),
  skipSchedule: (id: string) => api<ScheduledRun>(`/api/schedules/${id}/skip`, { method: 'POST' }),
  deleteSchedule: (id: string) => api<{ deleted: true }>(`/api/schedules/${id}`, { method: 'DELETE' }),
  pauseAllSchedules: (paused: boolean) => api<{ paused: boolean }>('/api/schedules/pause-all', { method: 'POST', body: { paused } }),
  createChat: (name: string, cwd?: string) => api<AgentRecord>('/api/agents', { method: 'POST', body: { name, cwd } }),
  createExpert: (chatId: string, input: { name: string; cwd?: string; message?: string }) =>
    api<AgentRecord>(`/api/agents/${chatId}/experts`, { method: 'POST', body: input }),
  fork: (id: string, promptUuid: string) => api<AgentRecord>(`/api/agents/${id}/fork`, { method: 'POST', body: { promptUuid } }),
  rewind: (id: string, promptUuid: string) => api<AgentRecord>(`/api/agents/${id}/rewind`, { method: 'POST', body: { promptUuid } }),
  send: (id: string, text: string, images: ImageData[] = []) =>
    api<QueuedMessage>(`/api/agents/${id}/messages`, { method: 'POST', body: images.length ? { text, images } : { text } }),
  interrupt: (id: string) => api<AgentRecord>(`/api/agents/${id}/interrupt`, { method: 'POST' }),
  stop: (id: string) => api<AgentRecord>(`/api/agents/${id}/stop`, { method: 'POST' }),
  removeQueued: (id: string, messageId: string) =>
    api<AgentRecord>(`/api/agents/${id}/queue/${messageId}`, { method: 'DELETE' }),
  setArchived: (id: string, archived: boolean) =>
    api<AgentRecord>(`/api/agents/${id}/archive`, { method: 'POST', body: { archived } }),
  setKeepWarm: (id: string, settings: { minutes: number; experts: boolean }) =>
    api<AgentRecord>(`/api/agents/${id}/keep-warm`, { method: 'POST', body: settings }),
  setNotificationsPaused: (id: string, paused: boolean) =>
    api<AgentRecord>(`/api/agents/${id}/notifications`, { method: 'POST', body: { paused } }),
  setModel: (id: string, change: { model?: string | null; effort?: EffortLevel | null }) =>
    api<AgentRecord>(`/api/agents/${id}/model`, { method: 'POST', body: change }),
  models: () => api<ModelOption[]>('/api/models'),
  commands: (id: string) => api<CommandOption[]>(`/api/agents/${id}/commands`),
  history: (id: string) => api<HistoryMessage[]>(`/api/agents/${id}/history`),
  btwStart: (id: string, text: string) => api<{ id: string }>(`/api/agents/${id}/btw`, { method: 'POST', body: { text } }),
  btwAsk: (chatId: string, text: string) => api<object>(`/api/btw/${chatId}/messages`, { method: 'POST', body: { text } }),
  /** keepalive: it still goes out while the page closes. */
  btwClose: (chatId: string) =>
    fetch(`/api/btw/${chatId}/close`, { method: 'POST', keepalive: true, headers: { authorization: `Bearer ${token}` } }).then(() => undefined),
  subagent: (id: string, toolUseId: string) => api<HistoryMessage[]>(`/api/agents/${id}/subagents/${toolUseId}`),
  startPlan: (id: string, start: string[], skip: string[]) => api<Plan>(`/api/plans/${id}/start`, { method: 'POST', body: { start, skip } }),
  setPlanNotify: (id: string, mode: 'round' | 'each') => api<Plan>(`/api/plans/${id}/notify`, { method: 'POST', body: { mode } }),
  answerQuestions: (id: string, answers: AnswerPayload[], corrections: { questionId: string; text: string }[]) =>
    api<QuestionSet>(`/api/questions/${id}/answer`, { method: 'POST', body: { answers, corrections } }),
  answerPermission: (agentId: string, requestId: string, decision: PermissionDecision, message?: string) =>
    api<PermissionRequest>(`/api/agents/${agentId}/permission`, { method: 'POST', body: { requestId, decision, message } }),
  info: () => (infoCache ??= fetchInfo()),

};
