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
  QueuedMessage,
  Track,
  UserQuestion,
} from '../../src/types';

export type { AgentRecord, CommandOption, EffortLevel, ImageData, ModelOption, PermissionDecision, PermissionRequest, Plan, QuestionSet, QueuedMessage, Track, UserQuestion };

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

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
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

export const commands = {
  createChat: (name: string, message?: string) =>
    api<AgentRecord>('/api/agents', { method: 'POST', body: { name, message } }),
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
  subagent: (id: string, toolUseId: string) => api<HistoryMessage[]>(`/api/agents/${id}/subagents/${toolUseId}`),
  startPlan: (id: string, start: string[], skip: string[]) => api<Plan>(`/api/plans/${id}/start`, { method: 'POST', body: { start, skip } }),
  setPlanNotify: (id: string, mode: 'round' | 'each') => api<Plan>(`/api/plans/${id}/notify`, { method: 'POST', body: { mode } }),
  answerQuestions: (id: string, answers: AnswerPayload[], corrections: { questionId: string; text: string }[]) =>
    api<QuestionSet>(`/api/questions/${id}/answer`, { method: 'POST', body: { answers, corrections } }),
  answerPermission: (agentId: string, requestId: string, decision: PermissionDecision, message?: string) =>
    api<PermissionRequest>(`/api/agents/${agentId}/permission`, { method: 'POST', body: { requestId, decision, message } }),
  info: () => api<{ orchestratorFolder: string; permissionMode: string; platform: string; defaultModel: string | null }>('/api/info'),
};
