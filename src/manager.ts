import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  forkSession,
  getSessionMessages,
  getSubagentMessages,
  listSubagents,
  query,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SessionMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { AgentRuntime, InputChannel, type RunSettings } from './agent.js';
import type { Config } from './config.js';
import {
  applyAnswers,
  checkUniqueIds,
  currentVersion,
  expertTracks,
  startMessage,
  toQuestions,
  toTracks,
  type AnswerInput,
  type AskInput,
  type CorrectionInput,
  type ProposeInput,
} from './decisions.js';
import { KeepWarm, active as keepWarmActive } from './keepwarm.js';
import { Scheduler } from './schedule.js';
import { nextAfter, preview, validateSchedule } from './cron.js';
import { SideChats, type SideChatEvent } from './sidechat.js';
import { allFiles, isInside } from './files.js';
import { StateStore, type State } from './state.js';
import { createDisplayTools } from './display.js';
import { createManagerTools } from './tools.js';
import { agentEnvironment } from './env.js';
import {
  EFFORT_LEVELS,
  deliverable,
  keepWarmCapMinutes,
  type AgentKind,
  type AgentRecord,
  type CommandOption,
  type EffortLevel,
  type ImageData,
  type KeepWarmSettings,
  type MessageSource,
  type ModelOption,
  type PermissionDecision,
  type PermissionRequest,
  type Plan,
  type QuestionSet,
  type QueuedImage,
  type QueuedMessage,
  type Reply,
  type ScheduledTask,
  type ScheduledRun,
  type ScheduleSpec,
  type ScheduleTarget,
} from './types.js';

const PREVIEW_CHARS = 300;

type MessageContent = SDKUserMessage['message']['content'];

const IMAGE_EXT: Record<ImageData['mediaType'], string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

export type ManagerEvents = {
  agent: [AgentRecord];
  message: [{ agentId: string; message: SDKMessage }];
  /** `images`: the images sent with the message, once, so open transcripts can show them right away. */
  delivered: [{ agentId: string; message: QueuedMessage; images?: ImageData[] }];
  plan: [Plan];
  questions: [QuestionSet];
  schedule: [ScheduledTask | { deleted: true; id: string } | { paused: boolean }];
  permission: [PermissionRequest];
  /** A side chat's progress (/btw). */
  btw: [SideChatEvent];
};

/** A pending request and how to answer the SDK's callback. */
type PendingPermission = { request: PermissionRequest; suggestions: PermissionUpdate[]; resolve: (r: PermissionResult) => void };

/** How many answered requests stay in memory, so a reloaded UI can still show their outcome. */
const ANSWERED_KEEP = 200;

/** Extra links a message can carry: the plan track or the routed question it belongs to. */
type MessageLinks = Pick<QueuedMessage, 'track' | 'question' | 'schedule'>;

/** A model/effort change: a missing field stays as it is, null goes back to the default. */
export type ModelChange = { model?: string | null; effort?: EffortLevel | null };

export class Manager extends EventEmitter<ManagerEvents> {
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly store: StateStore;
  private plans: Plan[];
  private questionSets: QuestionSet[];
  private schedules: ScheduledTask[];
  private schedulesPaused = false;
  private readonly scheduler: Scheduler;
  /** The supported models, learned from the first process that starts (or a probe). */
  private modelList: ModelOption[] | null = null;
  private modelProbe: Promise<ModelOption[]> | null = null;
  /** Skills and custom commands per folder, learned from processes that start there (or a probe). */
  private readonly commandLists = new Map<string, CommandOption[]>();
  private readonly commandProbes = new Map<string, Promise<CommandOption[]>>();
  /** Permission requests by id: pending ones, then the last few answered (for the UI). */
  private readonly permissions = new Map<string, PendingPermission | { request: PermissionRequest }>();
  /** Agent / Task tool call id → the subagent's id, learned while reading subagent transcripts. */
  private readonly subagentIds = new Map<string, string>();
  /** Pings that keep prompt caches warm between turns. */
  private readonly warmer = new KeepWarm({
    get: (id) => this.runtimes.get(id)?.rec,
    children: (id) => this.childrenOf(id),
    isBusy: (id) => this.runtimes.get(id)?.isBusy ?? false,
    options: (rec) => this.buildOptions(rec),
    changed: (rec) => this.changed(rec),
  });

  /** Side chats (/btw): throw-away forks that answer questions about a session without entering it. */
  readonly sideChats = new SideChats({
    get: (id) => this.get(id),
    options: (rec) => this.buildOptions(rec),
    addCost: (id, usd) => {
      const rec = this.runtimes.get(id)?.rec;
      if (!rec) return;
      rec.costUsd += usd;
      this.changed(rec);
    },
    emit: (e) => this.emit('btw', e),
  });

  /** Images of queued messages, one folder per agent, next to the state file. */
  private readonly uploadsDir: string;

  constructor(private readonly config: Config) {
    super();
    this.store = new StateStore(config.stateFile);
    this.uploadsDir = path.join(path.dirname(config.stateFile), 'uploads');
    const state = this.store.load();
    this.plans = state.plans;
    this.questionSets = state.questionSets;
    this.schedules = state.schedules;
    this.schedulesPaused = state.schedulesPaused;
    const interrupted = state.agents.filter((rec) => this.recover(rec));
    for (const task of this.schedules) for (const run of task.runs) {
      if (run.status === 'running') { run.status = 'interrupted'; run.reason = 'manager restarted'; run.endedAt = new Date().toISOString(); }
    }
    this.removeStrayUploads();
    // Parents are all loaded now, so their notifications have somewhere to go.
    for (const rec of interrupted) {
      this.notifyParent(rec, 'was interrupted because the manager restarted. Send it a message to continue.');
    }
    for (const rt of this.runtimes.values()) rt.pump();
    for (const rt of this.runtimes.values()) this.warmer.check(rt.rec);
    this.scheduler = new Scheduler({ tasks: () => this.schedules, paused: () => this.schedulesPaused,
      changed: (task) => this.scheduleChanged(task), startRun: (task, run) => this.startScheduleRun(task, run) },
      { enabled: config.schedules, catchUpDays: config.scheduleCatchUpDays,
        startupDelaySeconds: config.scheduleStartupDelaySeconds, maxRunning: config.scheduleMaxRunning });
  }

  // ---------- queries ----------

  list(): AgentRecord[] {
    return [...this.runtimes.values()].map((rt) => rt.rec);
  }

  get(id: string): AgentRecord {
    return this.runtime(id).rec;
  }

  childrenOf(parentId: string): AgentRecord[] {
    return this.list().filter((a) => a.parentId === parentId);
  }

  listPlans(): Plan[] {
    return this.plans;
  }

  listQuestionSets(): QuestionSet[] {
    return this.questionSets;
  }

  listSchedules(): ScheduledTask[] { return this.schedules; }
  schedulesArePaused(): boolean { return this.schedulesPaused; }

  previewSchedule(spec: ScheduleSpec): string[] { return preview(spec); }

  createSchedule(input: { name: string; prompt: string; target: ScheduleTarget; schedule: ScheduleSpec;
    paused?: boolean; proposedBy?: ScheduledTask['proposedBy']; missedRuns?: ScheduledTask['missedRuns'];
    unattended?: ScheduledTask['unattended']; keepRuns?: number }): ScheduledTask {
    if (!input.name?.trim() || !input.prompt?.trim()) throw new Error('Name and prompt are required');
    validateSchedule(input.schedule);
    if (input.schedule.kind === 'once' && Date.parse(input.schedule.at) <= Date.now()) throw new Error('The one-time run must be in the future');
    this.validateScheduleTarget(input.target);
    if (input.missedRuns !== undefined && !['run', 'ask', 'skip'].includes(input.missedRuns)) throw new Error('Invalid missed runs policy');
    if (input.unattended !== undefined && !['deny', 'ask'].includes(input.unattended)) throw new Error('Invalid permission policy');
    const now = new Date();
    const task: ScheduledTask = {
      id: newId('schedule'), name: input.name.trim(), prompt: input.prompt.trim(), target: input.target,
      schedule: input.schedule, status: input.proposedBy ? 'proposed' : input.paused ? 'paused' : 'active',
      missedRuns: input.missedRuns ?? this.config.scheduleMissedRuns, unattended: input.unattended ?? 'deny',
      keepRuns: this.keepRuns(input.keepRuns ?? 5), nextAt: nextAfter(input.schedule, now)?.toISOString() ?? null,
      runs: [], ...(input.proposedBy ? { proposedBy: input.proposedBy } : {}),
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
    };
    this.schedules.push(task);
    this.scheduleChanged(task);
    return task;
  }

  updateSchedule(id: string, patch: Partial<Pick<ScheduledTask, 'name' | 'prompt' | 'target' | 'schedule' | 'missedRuns' | 'unattended' | 'keepRuns'>>): ScheduledTask {
    const task = this.findSchedule(id);
    const spec = patch.schedule === undefined ? task.schedule : patch.schedule;
    validateSchedule(spec);
    if (patch.schedule?.kind === 'once' && Date.parse(patch.schedule.at) <= Date.now()) throw new Error('The one-time run must be in the future');
    if (patch.target !== undefined) this.validateScheduleTarget(patch.target);
    if (patch.name !== undefined && !patch.name.trim()) throw new Error('Name is required');
    if (patch.prompt !== undefined && !patch.prompt.trim()) throw new Error('Prompt is required');
    if (patch.missedRuns !== undefined && !['run', 'ask', 'skip'].includes(patch.missedRuns)) throw new Error('Invalid missed runs policy');
    if (patch.unattended !== undefined && !['deny', 'ask'].includes(patch.unattended)) throw new Error('Invalid permission policy');
    if (patch.name !== undefined) task.name = patch.name.trim();
    if (patch.prompt !== undefined) task.prompt = patch.prompt.trim();
    if (patch.target !== undefined) task.target = patch.target;
    if (patch.schedule !== undefined) task.schedule = patch.schedule;
    if (patch.missedRuns !== undefined) task.missedRuns = patch.missedRuns;
    if (patch.unattended !== undefined) task.unattended = patch.unattended;
    if (patch.keepRuns !== undefined) task.keepRuns = this.keepRuns(patch.keepRuns);
    if (patch.schedule) {
      task.nextAt = nextAfter(spec, new Date())?.toISOString() ?? null;
      if (task.status === 'done' && (task.nextAt || spec.kind === 'manual')) task.status = 'active';
    }
    task.updatedAt = new Date().toISOString();
    this.scheduleChanged(task);
    return task;
  }

  setSchedulePaused(id: string, paused: boolean): ScheduledTask {
    const task = this.findSchedule(id);
    if (task.status === 'proposed') throw new Error('Activate this proposal first');
    task.status = paused ? 'paused' : task.nextAt || task.schedule.kind === 'manual' ? 'active' : 'done';
    task.updatedAt = new Date().toISOString(); this.scheduleChanged(task);
    if (!paused) this.scheduler.tick();
    return task;
  }

  activateSchedule(id: string): ScheduledTask {
    const task = this.findSchedule(id);
    if (task.status !== 'proposed') throw new Error('This task is not proposed');
    task.nextAt = nextAfter(task.schedule, new Date())?.toISOString() ?? null;
    task.status = task.nextAt || task.schedule.kind === 'manual' ? 'active' : 'done';
    task.updatedAt = new Date().toISOString(); this.scheduleChanged(task);
    return task;
  }

  deleteSchedule(id: string): void {
    const index = this.schedules.findIndex((s) => s.id === id);
    if (index < 0) throw new Error('Unknown scheduled task');
    this.schedules.splice(index, 1);
    for (const rec of this.list()) if (rec.scheduleId === id) { delete rec.scheduleId; this.changed(rec); }
    this.emit('schedule', { deleted: true, id }); this.store.save(() => this.state());
  }

  pauseAllSchedules(paused: boolean): void { this.schedulesPaused = paused; this.store.save(() => this.state());
    this.emit('schedule', { paused });
    if (!paused) this.scheduler.tick();
  }

  runScheduleNow(id: string): ScheduledRun {
    const task = this.findSchedule(id);
    if (task.status === 'proposed') throw new Error('Activate this proposal first');
    const pending = task.runs.find((r) => r.status === 'pending');
    const run: ScheduledRun = pending ?? { id: newId('run'), dueAt: new Date().toISOString(), trigger: 'manual', status: 'waiting' };
    if (pending) pending.status = 'waiting'; else task.runs.push(run);
    run.requested = true;
    task.runs = task.runs.slice(-50);
    this.scheduleChanged(task); this.scheduler.drain();
    return run;
  }

  skipScheduleMiss(id: string): ScheduledRun {
    const task = this.findSchedule(id);
    const run = task.runs.find((r) => r.status === 'pending');
    if (!run) throw new Error('No missed run is pending');
    run.status = 'skipped'; run.reason = 'skipped by user'; run.endedAt = new Date().toISOString();
    this.scheduleChanged(task); return run;
  }

  private findSchedule(id: string): ScheduledTask {
    const task = this.schedules.find((s) => s.id === id);
    if (!task) throw new Error('Unknown scheduled task');
    return task;
  }
  private validateScheduleTarget(target: ScheduleTarget): void {
    if (!target || typeof target !== 'object') throw new Error('Choose a target');
    if (target.kind === 'newChat') {
      if (typeof target.cwd !== 'string') throw new Error('Choose a folder');
      validateDir(target.cwd);
      if (target.model != null && typeof target.model !== 'string') throw new Error('Invalid model');
      if (target.effort != null && !EFFORT_LEVELS.includes(target.effort)) throw new Error('Invalid effort');
    } else if (target.kind === 'agent') this.get(target.agentId);
    else throw new Error('Unknown target kind');
  }
  private keepRuns(n: number): number {
    if (!Number.isInteger(n) || n < 0 || n > 50) throw new Error('Keep runs must be between 0 and 50');
    return n;
  }
  private scheduleChanged(task: ScheduledTask): void { task.updatedAt = new Date().toISOString(); this.store.save(() => this.state()); this.emit('schedule', task); }

  private linkedRun(link: QueuedMessage['schedule']): { task: ScheduledTask; run: ScheduledRun } | null {
    if (!link) return null;
    const task = this.schedules.find((s) => s.id === link.taskId);
    const run = task?.runs.find((r) => r.id === link.runId);
    return task && run ? { task, run } : null;
  }

  private startScheduleRun(task: ScheduledTask, run: ScheduledRun): void {
    const previous = task.runs.find((r) => r.id !== run.id && (r.status === 'queued' || r.status === 'running'));
    const skip = (reason: string) => { run.status = 'skipped'; run.reason = reason; run.endedAt = new Date().toISOString(); this.scheduleChanged(task); };
    if (task.target.kind === 'agent') {
      const rec = this.runtimes.get(task.target.agentId)?.rec;
      if (!rec) return skip('chat was deleted');
      if (rec.archived) return skip('chat archived');
      if (previous?.status === 'queued') return skip('previous run still queued');
    } else if (previous) return skip('previous run still running');
    try {
      let agent: AgentRecord;
      if (task.target.kind === 'newChat') {
        const stamp = new Date(run.dueAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        agent = this.createAgent('orchestrator', `${task.name} · ${stamp}`, task.target.cwd, null,
          { model: task.target.model, effort: task.target.effort });
        agent.scheduleId = task.id;
        this.changed(agent);
      } else agent = this.get(task.target.agentId);
      const due = new Date(run.dueAt).toLocaleString();
      const started = new Date().toLocaleString();
      const label = run.trigger === 'catchUp' ? `catch-up: due ${due}, started ${started}` : `due ${due} · started ${started}`;
      run.status = 'queued'; run.agentId = agent.id;
      const message = this.sendMessage(agent.id, `[Scheduled task "${task.name}" · ${label}]\n${task.prompt}`, 'schedule', false,
        { schedule: { taskId: task.id, runId: run.id } });
      run.messageId = message.id;
      this.scheduleChanged(task);
    } catch (error) {
      run.status = 'failed'; run.reason = (error as Error).message; run.endedAt = new Date().toISOString();
      this.scheduleChanged(task);
    }
  }

  private archiveScheduleRuns(task: ScheduledTask): void {
    const ids = task.runs.filter((r) => r.agentId && ['done', 'failed', 'interrupted', 'cancelled'].includes(r.status))
      .map((r) => r.agentId!);
    for (const id of ids.slice(0, Math.max(0, ids.length - task.keepRuns))) {
      const rec = this.runtimes.get(id)?.rec;
      if (!rec || rec.archived || rec.current || rec.queue.length) continue;
      try { this.setArchived(id, true); } catch { /* a child may still be running */ }
    }
  }

  listPermissions(): PermissionRequest[] {
    return [...this.permissions.values()].map((p) => p.request);
  }

  /** Full transcript from Claude's own session files. */
  async history(id: string): Promise<SessionMessage[]> {
    const rec = this.get(id);
    if (!rec.sessionId) return [];
    return getSessionMessages(rec.sessionId, { dir: rec.cwd });
  }

  /**
   * The transcript of the subagent started by the tool call `toolUseId` (Agent / Task). Claude keeps it in
   * its own file next to the session; the messages carry the tool call's id as `parent_tool_use_id`.
   */
  async subagentHistory(id: string, toolUseId: string): Promise<SessionMessage[]> {
    const rec = this.get(id);
    if (!rec.sessionId) return [];
    const sessionId = rec.sessionId;
    const known = this.subagentIds.get(toolUseId);
    if (known) return getSubagentMessages(sessionId, known, { dir: rec.cwd });
    // Some paths don't match the project folder's name as given; without `dir` every project is searched.
    let ids = await listSubagents(sessionId, { dir: rec.cwd });
    if (ids.length === 0) ids = await listSubagents(sessionId);
    for (const agentId of ids) {
      let messages = await getSubagentMessages(sessionId, agentId, { dir: rec.cwd });
      if (messages.length === 0) messages = await getSubagentMessages(sessionId, agentId);
      const owner = messages.find((m) => m.parent_tool_use_id)?.parent_tool_use_id;
      if (owner) this.subagentIds.set(owner, agentId);
      if (owner === toolUseId) return messages;
    }
    return [];
  }

  // ---------- fork and rewind ----------

  /**
   * Fork: a new agent with the conversation up to the end of the turn that `promptUuid` starts. Same kind,
   * folder, parent, model and effort. The original is not touched and may keep running.
   */
  async fork(id: string, promptUuid: string): Promise<AgentRecord> {
    const rt = this.runtime(id);
    const rec = rt.rec;
    const { messages, next } = await this.findTurn(rec, promptUuid);
    if (next < 0 && rt.isBusy) throw new Error('This turn is still running. Fork from an earlier turn, or wait for it to end.');
    const name = `${rec.name} (fork)`;
    const forked = await forkSession(rec.sessionId!, {
      dir: rec.cwd,
      ...(next >= 0 ? { upToMessageId: messages[next - 1].uuid } : {}),
      title: name,
    });
    const until = next >= 0 ? timeOf(messages[next]) : Infinity;
    const copy = this.createAgent(rec.kind, name, rec.cwd, rec.parentId, { model: rec.model, effort: rec.effort });
    if (rec.taskFolder) copy.taskFolder = rec.taskFolder;
    copy.sessionId = forked.sessionId;
    copy.forkedFrom = rec.id;
    // What the original runs on, so the model chip is right before the fork's first turn.
    copy.activeModel = rec.activeModel;
    copy.activeEffort = rec.activeEffort;
    copy.replies = rec.replies.filter((r) => Date.parse(r.at) < until).map((r) => ({ ...r }));
    copy.context = next < 0 ? rec.context : null;
    // Cut at the end, the fork sends the same prefix, so the original's cache serves it too.
    copy.cache = next < 0 ? (rec.cache ?? null) : null;
    copy.lastActivityAt = copy.replies.at(-1)?.at ?? copy.createdAt;
    this.changed(copy);
    return copy;
  }

  /**
   * Rewind: drop the turn `promptUuid` starts and every turn after it. The agent switches to a fork of its
   * session cut just before that prompt (or a fresh session for the first turn); files are not touched,
   * and the old session stays on disk. Only when the agent is idle with nothing queued.
   */
  async rewind(id: string, promptUuid: string): Promise<AgentRecord> {
    const rt = this.runtime(id);
    const rec = rt.rec;
    if (rt.isBusy) throw new Error('Cannot rewind while the agent is running');
    if (rec.queue.length > 0) throw new Error('Cannot rewind with queued messages');
    const { messages, start } = await this.findTurn(rec, promptUuid);
    if (rt.isBusy || rec.queue.length > 0) throw new Error('The agent started a turn; try again when it is idle');
    const from = timeOf(messages[start]);
    let sessionId: string | null = null;
    if (start > 0) {
      sessionId = (await forkSession(rec.sessionId!, { dir: rec.cwd, upToMessageId: messages[start - 1].uuid, title: rec.name })).sessionId;
    }
    rt.release();
    rec.sessionId = sessionId;
    rec.replies = rec.replies.filter((r) => Date.parse(r.at) < from);
    rec.context = null;
    rec.cache = null;
    rec.status = 'idle';
    rec.lastError = null;
    // A plan or question set from the dropped turns would keep the chat in Needs you.
    for (const plan of this.plans) {
      if (plan.orchestratorId === rec.id && plan.status === 'waiting' && Date.parse(plan.createdAt) >= from) {
        plan.status = 'dropped';
        this.planChanged(plan);
      }
    }
    for (const set of this.questionSets) {
      if (set.orchestratorId === rec.id && (set.status === 'open' || set.status === 'chat') && Date.parse(set.createdAt) >= from) {
        set.status = 'dropped';
        this.questionsChanged(set);
      }
    }
    this.changed(rec);
    return rec;
  }

  /** The session's messages, the index of the prompt, and of the next prompt (-1 when it is the last turn). */
  private async findTurn(rec: AgentRecord, promptUuid: string): Promise<{ messages: SessionMessage[]; start: number; next: number }> {
    if (!rec.sessionId) throw new Error('This agent has no conversation yet');
    const messages = await getSessionMessages(rec.sessionId, { dir: rec.cwd });
    const start = messages.findIndex((m) => m.uuid === promptUuid);
    if (start < 0) throw new Error('That message is not in the session. Reload the page and try again.');
    const next = messages.findIndex((m, i) => i > start && isPrompt(m));
    return { messages, start, next };
  }

  // ---------- commands ----------

  /** A new chat, in `cwd` (absolute, must exist) or else the configured `orchestratorFolder`. */
  createOrchestrator(input: { name: string; cwd?: string; message?: string }): AgentRecord {
    const rec = this.createAgent('orchestrator', input.name, input.cwd ?? this.config.orchestratorFolder, null);
    if (input.message) this.sendMessage(rec.id, input.message, 'user', false);
    return rec;
  }

  /**
   * A new expert. Model and effort are optional: without them it takes its plan track's, and otherwise
   * runs on the same model and effort as its orchestrator does now.
   */
  createExpert(
    parentId: string,
    input: {
      name: string;
      cwd?: string;
      /** The task's folder inside the orchestrator's, given to the expert instead of the whole folder (default: the plan track's). */
      taskFolder?: string;
      message?: string;
      notify?: boolean;
      trackId?: string;
      model?: string;
      effort?: EffortLevel;
    },
    /** Who sends the first message: the orchestrator (create_expert) or the user (the UI, which tells no one). */
    from: 'orchestrator' | 'user' = 'orchestrator',
  ): AgentRecord {
    const parent = this.get(parentId);
    if (parent.kind !== 'orchestrator') throw new Error('Only orchestrators can create experts');
    const track = input.trackId ? this.findTrack(parentId, input.trackId) : undefined;
    const planned = track ? currentVersion(this.plan(track.planId)).tracks.find((t) => t.id === track.trackId) : undefined;
    const settings = this.expertSettings(parent, {
      model: input.model ?? planned?.model,
      effort: input.effort ?? planned?.effort,
    });
    const planTarget = planned?.target.kind === 'new_expert' ? planned.target : undefined;
    const taskFolder = input.taskFolder ?? planTarget?.taskFolder;
    // Checked before the agent exists, so a wrong folder leaves nothing behind.
    const confined = taskFolder ? checkTaskFolder(parent.cwd, taskFolder, true) : undefined;
    const rec = this.createAgent('expert', input.name, input.cwd ?? parent.cwd, parent.id, settings);
    if (confined) rec.taskFolder = confined;
    if (track) this.linkTrack(track, rec.id);
    if (input.message) this.sendMessage(rec.id, input.message, from, from === 'orchestrator' && (input.notify ?? true), { track });
    return rec;
  }

  /** message_expert, with the optional track or routed question it belongs to. */
  messageExpert(
    parentId: string,
    expertId: string,
    input: { message: string; notify: boolean; trackId?: string; questionId?: string },
  ): QueuedMessage {
    const track = input.trackId ? this.findTrack(parentId, input.trackId) : undefined;
    const question = input.questionId ? this.findRouted(parentId, input.questionId, expertId) : undefined;
    if (track) this.linkTrack(track, expertId);
    return this.sendMessage(expertId, input.message, 'orchestrator', input.notify, { track, question });
  }

  sendMessage(
    id: string,
    text: string,
    source: MessageSource,
    notify: boolean,
    links: MessageLinks = {},
    images: ImageData[] = [],
  ): QueuedMessage {
    const rt = this.runtime(id);
    if (!text.trim() && images.length === 0) throw new Error('Message is empty');
    let body = text;
    if (source === 'orchestrator' && rt.rec.parentId) {
      body = `[Message from orchestrator "${this.get(rt.rec.parentId).name}"]\n${text}`;
    }
    const message: QueuedMessage = {
      id: newId('msg'),
      text: body,
      source,
      notify: notify && rt.rec.parentId !== null,
      queuedAt: new Date().toISOString(),
      ...(links.track ? { track: links.track } : {}),
      ...(links.question ? { question: links.question } : {}),
      ...(links.schedule ? { schedule: links.schedule } : {}),
    };
    if (images.length) message.images = this.saveImages(rt.rec.id, message.id, images);
    if (source !== 'schedule') this.unarchive(rt.rec);
    rt.enqueue(message);
    return message;
  }

  /** Keep a queued message's images as files until it is delivered (the state file only names them). */
  private saveImages(agentId: string, messageId: string, images: ImageData[]): QueuedImage[] {
    mkdirSync(path.join(this.uploadsDir, agentId), { recursive: true });
    return images.map((image, n) => {
      const file = `${agentId}/${messageId}-${n + 1}.${IMAGE_EXT[image.mediaType]}`;
      writeFileSync(path.join(this.uploadsDir, file), Buffer.from(image.data, 'base64'));
      return { file, mediaType: image.mediaType };
    });
  }

  /** What the agent gets: the text alone, or the images followed by the text. */
  private messageContent(message: QueuedMessage): MessageContent {
    if (!message.images?.length) return message.text;
    const blocks: Exclude<MessageContent, string> = message.images.map((image) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: image.mediaType,
        data: readFileSync(path.join(this.uploadsDir, image.file)).toString('base64'),
      },
    }));
    if (message.text.trim()) blocks.push({ type: 'text', text: message.text });
    return blocks;
  }

  private onDeliver(rec: AgentRecord, message: QueuedMessage, content: MessageContent): void {
    const scheduled = this.linkedRun(message.schedule);
    if (scheduled) {
      scheduled.run.status = 'running'; scheduled.run.startedAt = rec.turnStartedAt ?? new Date().toISOString();
      scheduled.run.promptUuid = message.uuid;
      this.scheduleChanged(scheduled.task);
    }
    const images: ImageData[] = [];
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'image' && b.source.type === 'base64') images.push({ mediaType: b.source.media_type, data: b.source.data });
      }
    }
    this.emit('delivered', { agentId: rec.id, message, ...(images.length ? { images } : {}) });
    // Claude Code keeps the images in its session file from here on.
    this.discardImages([message]);
  }

  private discardImages(messages: QueuedMessage[]): void {
    const dirs = new Set<string>();
    for (const m of messages) {
      for (const image of m.images ?? []) {
        const file = path.join(this.uploadsDir, image.file);
        rmSync(file, { force: true });
        dirs.add(path.dirname(file));
      }
    }
    for (const dir of dirs) {
      if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
    }
  }

  /** On startup: remove files no queued message refers to (a crash between delivery and cleanup, a lost turn). */
  private removeStrayUploads(): void {
    if (!existsSync(this.uploadsDir)) return;
    const used = new Set<string>();
    for (const rt of this.runtimes.values()) {
      for (const m of rt.rec.queue) for (const image of m.images ?? []) used.add(path.normalize(image.file));
    }
    for (const agent of readdirSync(this.uploadsDir)) {
      const dir = path.join(this.uploadsDir, agent);
      if (!statSync(dir).isDirectory()) continue;
      for (const file of readdirSync(dir)) {
        if (!used.has(path.normalize(`${agent}/${file}`))) rmSync(path.join(dir, file), { force: true });
      }
      if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Cancel the running turn but keep the queue; the next queued message is delivered afterwards. */
  async interrupt(id: string): Promise<void> {
    this.cancelPermissions(id, true);
    if (!(await this.runtime(id).interrupt())) throw new Error('The agent is not running');
  }

  removeQueued(id: string, messageId: string): void {
    const rt = this.runtime(id);
    const message = rt.rec.queue.find((m) => m.id === messageId);
    if (!message || !rt.removeQueued(messageId)) throw new Error('That message is no longer queued');
    this.discardImages([message]);
    const scheduled = this.linkedRun(message.schedule);
    if (scheduled) { scheduled.run.status = 'cancelled'; scheduled.run.endedAt = new Date().toISOString(); this.scheduleChanged(scheduled.task); this.scheduler.drain(); }
  }

  /** Switch an agent's model and/or effort. A running turn finishes as it is; the next turn uses the new values. */
  setModel(id: string, change: ModelChange): AgentRecord {
    const rt = this.runtime(id);
    const rec = rt.rec;
    const model = change.model === undefined ? rec.model : change.model?.trim() || null;
    let effort = change.effort === undefined ? rec.effort : change.effort;
    if (effort !== null && !EFFORT_LEVELS.includes(effort)) throw new Error(`Unknown effort "${effort}"`);
    const info = this.checkModel(model);
    // Switching only the model: an effort the new model can't run goes back to its default.
    if (change.effort === undefined && effort && info && !supportsEffort(info, effort)) effort = null;
    if (effort && info && !supportsEffort(info, effort)) throw new Error(effortError(info, effort));
    // The cache belongs to a model: the next turn on another one starts a new cache.
    if (model !== rec.model) rec.cache = null;
    rec.model = model;
    rec.effort = effort;
    rt.updateSettings();
    this.changed(rec);
    return rec;
  }

  /**
   * Keep the agent's prompt cache warm: for some minutes after each turn (capped by the cache's TTL), and
   * for chats also while their experts work. Both off turns it off. Changing it gives a stopped episode
   * another go.
   */
  setKeepWarm(id: string, settings: KeepWarmSettings): AgentRecord {
    const rec = this.get(id);
    const max = keepWarmCapMinutes(3600);
    if (!Number.isInteger(settings.minutes) || settings.minutes < 0 || settings.minutes > max) {
      throw new Error(`"minutes" must be a whole number from 0 to ${max}`);
    }
    const next: KeepWarmSettings = { minutes: settings.minutes, experts: settings.experts && rec.kind === 'orchestrator' };
    rec.keepWarm = next.minutes > 0 || next.experts ? next : null;
    if (rec.warm?.stopped) delete rec.warm.stopped;
    this.changed(rec);
    return rec;
  }

  /**
   * Pause or resume a chat's expert notifications. While paused they wait in the queue and the user's
   * messages go first; resuming merges the held ones into one message that is delivered as usual.
   */
  setNotificationsPaused(id: string, paused: boolean): AgentRecord {
    const rt = this.runtime(id);
    const rec = rt.rec;
    if (rec.kind !== 'orchestrator') throw new Error('Only chats get expert notifications');
    if (paused === (rec.notificationsPaused === true)) return rec;
    if (paused) {
      rec.notificationsPaused = true;
    } else {
      delete rec.notificationsPaused;
      const held = rec.queue.filter((m) => m.source === 'manager');
      if (held.length > 1) {
        const n = held.length;
        const header = `[Manager notification] ${n} notifications arrived while the user had paused them:`;
        const merged: QueuedMessage = { ...held[0], text: [header, ...held.map((m) => m.text)].join('\n\n') };
        const first = rec.queue.indexOf(held[0]);
        rec.queue = rec.queue.filter((m) => m.source !== 'manager');
        rec.queue.splice(first, 0, merged);
      }
    }
    this.changed(rec);
    rt.pump();
    return rec;
  }

  /** The supported models (aliases and ids), cached for the manager's lifetime. */
  async models(): Promise<ModelOption[]> {
    if (this.modelList) return this.modelList;
    this.modelProbe ??= this.probe(this.config.orchestratorFolder)
      .then(() => this.modelList ?? [])
      .finally(() => (this.modelProbe = null));
    return this.modelProbe;
  }

  /** The skills and custom commands an agent can run, per folder (Claude Code's own commands left out). */
  async commands(id: string): Promise<CommandOption[]> {
    return this.scheduleCommands(this.get(id).cwd);
  }

  /** Skills offered by a scheduled task's target folder, before its new chat exists. */
  async scheduleCommands(folder: string): Promise<CommandOption[]> {
    const cwd = validateDir(folder);
    const known = this.commandLists.get(cwd);
    if (known) return known;
    let probe = this.commandProbes.get(cwd);
    if (!probe) {
      probe = this.probe(cwd)
        .then(() => this.commandLists.get(cwd) ?? [])
        .finally(() => this.commandProbes.delete(cwd));
      this.commandProbes.set(cwd, probe);
    }
    return probe;
  }

  /** File paths available to mention in a scheduled prompt. */
  scheduleFiles(folder: string): Promise<{ files: string[]; truncated: boolean }> {
    return allFiles(validateDir(folder));
  }

  /**
   * Renames an agent. Only the record changes: a running expert's system prompt keeps the name it started
   * with until its process restarts, which keeps the prompt cache intact.
   */
  rename(id: string, name: string): AgentRecord {
    const rec = this.get(id);
    const trimmed = name.trim();
    if (!trimmed) throw new Error('The name cannot be empty');
    if (trimmed.length > 100) throw new Error('The name can be at most 100 characters');
    if (rec.name !== trimmed) {
      rec.name = trimmed;
      this.changed(rec);
    }
    return rec;
  }

  /**
   * Archive or unarchive an agent. A chat takes its experts with it, and unarchiving the chat brings
   * back the ones that went with it. Archiving closes the processes; the next message resumes them.
   */
  setArchived(id: string, archived: boolean): AgentRecord {
    const rt = this.runtime(id);
    const rec = rt.rec;
    if (!archived) {
      this.unarchive(rec);
      if (rec.kind === 'orchestrator') {
        for (const child of this.childrenOf(rec.id)) {
          if (child.archivedWith === rec.id) this.unarchive(child);
        }
      }
      return rec;
    }
    if (rec.archived) return rec;
    const children = rec.kind === 'orchestrator' ? this.childrenOf(rec.id).filter((c) => !c.archived) : [];
    const busy = [rec, ...children].find((a) => this.runtime(a.id).isBusy || a.queue.length > 0);
    if (busy) {
      throw new Error(busy === rec ? 'Cannot archive a running agent' : `Cannot archive this chat while its expert "${busy.name}" is running`);
    }
    for (const a of [rec, ...children]) {
      a.archived = true;
      a.archivedWith = a === rec ? null : rec.id;
      this.runtime(a.id).release();
      this.changed(a);
    }
    return rec;
  }

  /** A message to an archived agent brings it back, and an expert's archived chat with it. */
  private unarchive(rec: AgentRecord): void {
    if (rec.archived) {
      rec.archived = false;
      rec.archivedWith = null;
      this.changed(rec);
    }
    const parent = rec.parentId ? this.runtimes.get(rec.parentId)?.rec : undefined;
    if (parent?.archived) this.unarchive(parent);
  }

  async stop(id: string, by: MessageSource): Promise<void> {
    const rt = this.runtime(id);
    this.cancelPermissions(id, true);
    const dropped = [...rt.rec.queue];
    const handled = await rt.stop();
    this.discardImages(dropped);
    for (const message of dropped) {
      const scheduled = this.linkedRun(message.schedule);
      if (scheduled) { scheduled.run.status = 'cancelled'; scheduled.run.endedAt = new Date().toISOString(); this.scheduleChanged(scheduled.task); }
    }
    const scheduled = this.linkedRun(handled?.schedule);
    if (scheduled) { scheduled.run.status = 'cancelled'; scheduled.run.endedAt = new Date().toISOString(); this.scheduleChanged(scheduled.task); }
    this.scheduler.drain();
    if (handled?.notify && by !== 'orchestrator') {
      this.notifyParent(rt.rec, `was stopped by the ${by} before finishing its turn.`);
    }
  }

  shutdown(): void {
    this.scheduler.dispose();
    this.warmer.dispose();
    this.sideChats.dispose();
    for (const rt of this.runtimes.values()) rt.dispose();
    this.store.writeNow(this.state());
  }

  // ---------- permission prompts ----------

  /**
   * canUseTool: auto mode's classifier couldn't decide, so the user does. The call waits as long as it
   * takes; interrupt, stop or the end of the turn cancel it.
   */
  private askPermission(agentId: string, ...[toolName, input, opts]: Parameters<CanUseTool>): Promise<PermissionResult> {
    // Claude's own ask-the-user tool has no surface here: questions go through ask_user or the reply.
    if (toolName === 'AskUserQuestion') {
      const rec = this.runtimes.get(agentId)?.rec;
      const how =
        rec?.kind === 'orchestrator'
          ? 'Use the ask_user tool from the manager instead.'
          : 'Ask your question in your reply instead; your orchestrator reads it.';
      return Promise.resolve({ behavior: 'deny', message: `AskUserQuestion is not available in this manager. ${how}` });
    }
    if (toolName === 'ExitPlanMode') return Promise.resolve({ behavior: 'allow', updatedInput: input });
    const scheduled = this.linkedRun(this.runtimes.get(agentId)?.rec.current?.schedule);
    if (scheduled?.task.unattended === 'deny') {
      scheduled.run.denied = (scheduled.run.denied ?? 0) + 1;
      this.scheduleChanged(scheduled.task);
      return Promise.resolve({ behavior: 'deny', message: 'This is a scheduled run and nobody is watching. Skip this step, and say in your reply what you needed permission for.' });
    }
    const suggestions = opts.suggestions ?? [];
    const request: PermissionRequest = {
      id: newId('perm'),
      agentId,
      toolName,
      toolUseId: opts.toolUseID,
      input,
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.decisionReason ? { reason: opts.decisionReason } : {}),
      ...(opts.blockedPath ? { blockedPath: opts.blockedPath } : {}),
      canAllowSession: suggestions.length > 0 && !opts.suppressAlwaysAllowRule,
      defaultToNo: opts.defaultToNo === true,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    return new Promise<PermissionResult>((resolve) => {
      this.permissions.set(request.id, { request, suggestions, resolve });
      opts.signal.addEventListener(
        'abort',
        () => this.settlePermission(request.id, 'cancelled', { behavior: 'deny', message: 'Cancelled.', interrupt: true }),
        { once: true },
      );
      this.emit('permission', request);
      const rec = this.runtimes.get(agentId)?.rec;
      if (rec) this.changed(rec);
    });
  }

  /** The user's answer. Allow for this session adds the SDK's suggested rules to this session only. */
  answerPermission(agentId: string, requestId: string, decision: PermissionDecision, message?: string): PermissionRequest {
    const entry = this.permissions.get(requestId);
    if (!entry || entry.request.agentId !== agentId) throw new Error('Unknown permission request');
    if (!('resolve' in entry)) throw new Error('This request was already answered');
    if (decision === 'allowSession' && !entry.request.canAllowSession) throw new Error('This request can only be allowed once');
    const note = message?.trim();
    let result: PermissionResult;
    if (decision === 'deny') {
      result = { behavior: 'deny', message: note ? `The user denied this: ${note}` : 'The user denied this.' };
    } else {
      result = { behavior: 'allow', updatedInput: entry.request.input };
      if (decision === 'allowSession') {
        result.updatedPermissions = entry.suggestions.map((s) => ('destination' in s ? { ...s, destination: 'session' as const } : s));
      }
    }
    const status = decision === 'allow' ? 'allowed' : decision === 'allowSession' ? 'allowedSession' : 'denied';
    this.settlePermission(requestId, status, result, note);
    return entry.request;
  }

  /** Answer a pending request and keep it, answered, for a while so the UI can show the outcome. */
  private settlePermission(requestId: string, status: PermissionRequest['status'], result: PermissionResult, message?: string): void {
    const entry = this.permissions.get(requestId);
    if (!entry || !('resolve' in entry)) return;
    entry.request.status = status;
    entry.request.answeredAt = new Date().toISOString();
    if (message) entry.request.message = message;
    this.permissions.set(requestId, { request: entry.request });
    entry.resolve(result);
    const answered = [...this.permissions.values()].filter((p) => !('resolve' in p));
    for (const old of answered.slice(0, Math.max(0, answered.length - ANSWERED_KEEP))) this.permissions.delete(old.request.id);
    this.emit('permission', entry.request);
    const rec = this.runtimes.get(entry.request.agentId)?.rec;
    if (rec) this.changed(rec);
  }

  /** Cancel an agent's pending requests (interrupt, stop, or the turn ended). */
  private cancelPermissions(agentId: string, interrupt: boolean): void {
    for (const p of [...this.permissions.values()]) {
      if (p.request.agentId === agentId && 'resolve' in p) {
        this.settlePermission(p.request.id, 'cancelled', { behavior: 'deny', message: 'Cancelled.', interrupt });
      }
    }
  }

  // ---------- track plans ----------

  /** propose_tracks: a new plan for the round, or a new version of the round's waiting plan. */
  proposeTracks(orchestratorId: string, input: ProposeInput, toolUseId?: string): Plan {
    const orch = this.get(orchestratorId);
    if (orch.kind !== 'orchestrator') throw new Error('Only orchestrators can propose tracks');
    const tracks = toTracks(input.tracks);
    for (const t of tracks) {
      if (t.target.kind === 'existing_expert' && this.runtimes.get(t.target.expertId)?.rec.parentId !== orchestratorId) {
        throw new Error(`Track "${t.id}": expert ${t.target.expertId} is not one of yours`);
      }
      if (t.target.kind === 'new_expert' && t.target.folder) validateDir(t.target.folder);
      // The folder may not exist yet: the orchestrator writes the handoff files when it starts the track.
      if (t.target.kind === 'new_expert' && t.target.taskFolder) checkTaskFolder(orch.cwd, t.target.taskFolder, false);
    }
    const now = new Date().toISOString();
    let plan = this.plans.find((p) => p.orchestratorId === orchestratorId && p.round === input.round);
    if (plan?.status === 'started') {
      throw new Error(`Round ${input.round} was already started. Propose the next round with a higher round number.`);
    }
    const version = {
      version: (plan?.versions.length ?? 0) + 1,
      title: input.title,
      tracks,
      later: input.later ?? [],
      proposedAt: now,
      ...(toolUseId ? { toolUseId } : {}),
    };
    if (plan) {
      plan.versions.push(version);
      plan.updatedAt = now;
    } else {
      plan = {
        id: newId('plan'),
        orchestratorId,
        round: input.round,
        versions: [version],
        status: 'waiting',
        startedAt: null,
        chosen: null,
        skipped: null,
        experts: {},
        replied: {},
        notify: 'round',
        held: [],
        createdAt: now,
        updatedAt: now,
      };
      this.plans.push(plan);
    }
    this.planChanged(plan);
    return plan;
  }

  /** Start: the checked and skipped tracks go to the orchestrator as one message, nothing else. */
  startPlan(planId: string, start: string[], skip: string[]): Plan {
    const plan = this.plan(planId);
    if (plan.status !== 'waiting') throw new Error(plan.status === 'dropped' ? 'This plan was rewound away' : 'This plan was already started');
    const ids = currentVersion(plan).tracks.map((t) => t.id);
    checkUniqueIds([...start, ...skip], 'track');
    for (const id of [...start, ...skip]) if (!ids.includes(id)) throw new Error(`Unknown track "${id}"`);
    if (start.length === 0) throw new Error('Check at least one track to start');
    const now = new Date().toISOString();
    plan.status = 'started';
    plan.startedAt = now;
    plan.chosen = start;
    plan.skipped = skip;
    plan.updatedAt = now;
    this.sendMessage(plan.orchestratorId, startMessage(plan, start, skip), 'user', false);
    this.planChanged(plan);
    return plan;
  }

  setPlanNotify(planId: string, mode: 'round' | 'each'): Plan {
    const plan = this.plan(planId);
    plan.notify = mode;
    if (mode === 'each') this.releaseHeld(plan);
    plan.updatedAt = new Date().toISOString();
    this.planChanged(plan);
    return plan;
  }

  /** The orchestrator's plan holding this track: the newest one, preferring started plans. */
  private findTrack(orchestratorId: string, trackId: string): { planId: string; trackId: string } {
    const plans = this.plans
      .filter((p) => p.orchestratorId === orchestratorId && currentVersion(p).tracks.some((t) => t.id === trackId))
      .sort((a, b) => Number(b.status === 'started') - Number(a.status === 'started') || b.createdAt.localeCompare(a.createdAt));
    if (!plans[0]) throw new Error(`No plan of yours has a track "${trackId}"`);
    return { planId: plans[0].id, trackId };
  }

  private linkTrack(track: { planId: string; trackId: string }, expertId: string): void {
    const plan = this.plan(track.planId);
    if (plan.status === 'waiting') {
      // Started from the chat ("only start track 1"): the tracker follows what was actually started.
      plan.status = 'started';
      plan.startedAt = new Date().toISOString();
    }
    plan.experts[track.trackId] = expertId;
    plan.updatedAt = new Date().toISOString();
    this.planChanged(plan);
  }

  /**
   * Release the round's held notifications once every started track has replied, and either every
   * chosen track has been started or the orchestrator is idle (so it won't start more).
   */
  private checkRound(plan: Plan): void {
    if (plan.held.length === 0) return;
    const started = Object.keys(plan.experts);
    if (!started.every((id) => plan.replied[id])) return;
    const allStarted = expertTracks(plan).every((id) => plan.experts[id]);
    const orch = this.runtimes.get(plan.orchestratorId);
    const orchIdle = !orch || (!orch.isBusy && deliverable(orch.rec).length === 0);
    if (allStarted || orchIdle) this.releaseHeld(plan);
  }

  private releaseHeld(plan: Plan): void {
    if (plan.held.length === 0) return;
    const held = plan.held;
    plan.held = [];
    const v = currentVersion(plan);
    const n = Object.keys(plan.experts).length;
    const header = `[Manager notification] Round ${plan.round} of "${v.title}": all ${n} started track${n === 1 ? '' : 's'} replied.`;
    // One message: enqueueing them one by one would wake an idle orchestrator on the header alone,
    // and the track replies would follow as a second turn.
    this.enqueueNotification(plan.orchestratorId, [header, ...held].join('\n\n'));
    this.planChanged(plan);
  }

  private plan(id: string): Plan {
    const plan = this.plans.find((p) => p.id === id);
    if (!plan) throw new Error(`Unknown plan: ${id}`);
    return plan;
  }

  private planChanged(plan: Plan): void {
    this.store.save(() => this.state());
    this.emit('plan', plan);
  }

  // ---------- question sets ----------

  /** ask_user: questions for the user, plus what the orchestrator answered or routed itself. */
  askUser(orchestratorId: string, input: AskInput, toolUseId?: string): QuestionSet {
    const orch = this.get(orchestratorId);
    if (orch.kind !== 'orchestrator') throw new Error('Only orchestrators can ask the user');
    const resolved = input.resolved ?? [];
    const routed = input.routed ?? [];
    checkUniqueIds([...input.questions.map((q) => q.id), ...resolved.map((q) => q.id), ...routed.map((q) => q.id)], 'question');
    if (input.questions.length === 0) throw new Error('Ask at least one question');
    for (const q of routed) {
      if (this.runtimes.get(q.expertId)?.rec.parentId !== orchestratorId) throw new Error(`Question "${q.id}": expert ${q.expertId} is not one of yours`);
    }
    const now = new Date().toISOString();
    const set: QuestionSet = {
      id: newId('qs'),
      orchestratorId,
      title: input.title,
      questions: toQuestions(input.questions),
      resolved,
      routed,
      status: 'open',
      ...(toolUseId ? { toolUseId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.questionSets.push(set);
    this.questionsChanged(set);
    return set;
  }

  /** Send: only the answers and corrections, as one message to the orchestrator. */
  answerQuestions(setId: string, answers: AnswerInput[], corrections: CorrectionInput[]): QuestionSet {
    const set = this.questionSet(setId);
    if (answers.length === 0 && corrections.length === 0) throw new Error('Nothing to send');
    const text = applyAnswers(set, answers, corrections);
    this.sendMessage(set.orchestratorId, text, 'user', false);
    this.questionsChanged(set);
    return set;
  }

  /**
   * The user wrote in the chat instead of answering: the chat's open question sets stop waiting
   * (the UI folds them; they can still be answered).
   */
  setAsideQuestions(orchestratorId: string): void {
    const now = new Date().toISOString();
    for (const set of this.questionSets) {
      if (set.orchestratorId !== orchestratorId || set.status !== 'open') continue;
      set.status = 'chat';
      set.updatedAt = now;
      this.questionsChanged(set);
    }
  }

  private findRouted(orchestratorId: string, questionId: string, expertId: string): { setId: string; questionId: string } {
    const set = [...this.questionSets]
      .reverse()
      .find((s) => s.orchestratorId === orchestratorId && s.routed.some((q) => q.id === questionId));
    if (!set) throw new Error(`No question set of yours routes a question "${questionId}". Call ask_user first.`);
    const q = set.routed.find((x) => x.id === questionId)!;
    if (q.expertId !== expertId) {
      q.expertId = expertId;
      this.questionsChanged(set);
    }
    return { setId: set.id, questionId };
  }

  private questionSet(id: string): QuestionSet {
    const set = this.questionSets.find((s) => s.id === id);
    if (!set) throw new Error(`Unknown question set: ${id}`);
    return set;
  }

  private questionsChanged(set: QuestionSet): void {
    this.store.save(() => this.state());
    this.emit('questions', set);
  }

  private state(): State {
    return { agents: this.list(), plans: this.plans, questionSets: this.questionSets, schedules: this.schedules, schedulesPaused: this.schedulesPaused };
  }

  // ---------- model and effort ----------

  /** An expert's model and effort: the explicit ones, else the orchestrator's (what it is set to, else what it runs on). */
  private expertSettings(parent: AgentRecord, input: { model?: string; effort?: EffortLevel }): Pick<AgentRecord, 'model' | 'effort'> {
    const model = input.model?.trim() || parent.model || parent.activeModel || null;
    const info = this.checkModel(model);
    if (input.effort) {
      if (!EFFORT_LEVELS.includes(input.effort)) throw new Error(`Unknown effort "${input.effort}"`);
      if (info && !supportsEffort(info, input.effort)) throw new Error(effortError(info, input.effort));
      return { model, effort: input.effort };
    }
    const inherited = parent.effort ?? parent.activeEffort;
    // An inherited effort the expert's model can't run is dropped (the model's default applies).
    return { model, effort: inherited && (!info || supportsEffort(info, inherited)) ? inherited : null };
  }

  /** The list entry for a model, or undefined when the list isn't known yet. Throws for an unknown model. */
  private checkModel(model: string | null): ModelOption | undefined {
    if (!this.modelList) return undefined;
    const value = model ?? this.config.model ?? 'default';
    const info = findModel(this.modelList, value);
    if (!info && model) {
      const aliases = this.modelList.filter((m) => !m.value.startsWith('claude-') && m.value !== 'default').map((m) => m.value);
      throw new Error(`Unknown model "${model}". Use an alias (${aliases.join(', ')}) or a model id.`);
    }
    return info;
  }

  private runSettings(rec: AgentRecord): RunSettings {
    const model = rec.model ?? this.config.model ?? undefined;
    return { ...(model ? { model } : {}), ...(rec.effort ? { effort: rec.effort } : {}) };
  }

  /** Learn the models and the folder's commands from a process that just started. */
  private learnFrom(cwd: string, q: Query): Promise<void> {
    const models = this.modelList
      ? Promise.resolve()
      : q.supportedModels().then((list) => void (this.modelList ??= list.map(toModelOption)));
    const commands = q.supportedCommands().then((list) => this.setCommands(cwd, list));
    // The process may have closed; the next one tries again.
    return Promise.all([models.catch(() => {}), commands.catch(() => {})]).then(() => {});
  }

  private setCommands(cwd: string, list: { name: string; description: string; argumentHint: string; builtin?: boolean }[]): void {
    const seen = new Set<string>();
    const commands = list
      .filter((c) => !c.builtin && !seen.has(c.name) && seen.add(c.name))
      .map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint }))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.commandLists.set(cwd, commands);
  }

  /**
   * Start a process without a prompt just to ask for the models and the folder's commands. It sends
   * nothing to the API. It loads the same settings and skills as an agent in that folder.
   */
  private async probe(cwd: string): Promise<void> {
    const input = new InputChannel();
    const q = query({
      prompt: input,
      options: { cwd, env: this.agentEnv(), persistSession: false, settingSources: ['user', 'project', 'local'], skills: 'all', stderr: () => {} },
    });
    try {
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out asking Claude Code')), 60_000).unref());
      await Promise.race([this.learnFrom(cwd, q), timeout]);
    } finally {
      input.close();
      q.close();
    }
  }

  // ---------- internals ----------

  private createAgent(
    kind: AgentKind,
    name: string,
    cwd: string,
    parentId: string | null,
    settings: Pick<AgentRecord, 'model' | 'effort'> = { model: null, effort: null },
  ): AgentRecord {
    const dir = validateDir(cwd);
    const now = new Date().toISOString();
    const rec: AgentRecord = {
      id: newId(slug(name) || kind),
      name: name.trim() || kind,
      kind,
      parentId,
      cwd: dir,
      sessionId: null,
      status: 'idle',
      lastError: null,
      queue: [],
      replies: [],
      current: null,
      turnStartedAt: null,
      costUsd: 0,
      archived: false,
      archivedWith: null,
      lastActivityAt: now,
      context: null,
      model: settings.model,
      effort: settings.effort,
      activeModel: null,
      activeEffort: null,
      createdAt: now,
      updatedAt: now,
    };
    this.addRuntime(rec);
    this.changed(rec);
    return rec;
  }

  /**
   * Restore a record from disk. A turn that was running when we went down is
   * marked interrupted. Returns true when the parent should be told about it.
   */
  private recover(rec: AgentRecord): boolean {
    const handled = rec.current;
    const wasRunning = rec.status === 'running' || handled !== null;
    if (wasRunning) {
      rec.status = 'interrupted';
      rec.current = null;
      rec.turnStartedAt = null;
    }
    this.addRuntime(rec);
    return wasRunning && handled?.notify === true;
  }

  private addRuntime(rec: AgentRecord): void {
    this.runtimes.set(
      rec.id,
      new AgentRuntime(rec, {
        buildOptions: (r) => this.buildOptions(r),
        runSettings: (r) => this.runSettings(r),
        onStarted: (r, q) => void this.learnFrom(r.cwd, q),
        onMessage: (r, message) => {
          if (message.type === 'system' && message.subtype === 'commands_changed') this.setCommands(r.cwd, message.commands);
          this.emit('message', { agentId: r.id, message });
        },
        content: (_r, message) => this.messageContent(message),
        onDeliver: (r, message, content) => this.onDeliver(r, message, content),
        onTurnEnd: (r, handled, reply) => this.onTurnEnd(r, handled, reply),
        onChange: (r) => this.changed(r),
      }, this.config.idleMinutes * 60_000),
    );
  }

  private onTurnEnd(rec: AgentRecord, handled: QueuedMessage, reply: Reply): void {
    const scheduled = this.linkedRun(handled.schedule);
    if (scheduled) {
      reply.scheduled = true;
      const { task, run } = scheduled;
      if (run.status !== 'cancelled') run.status = reply.interrupted ? 'interrupted' : reply.isError ? 'failed' : 'done';
      run.endedAt = reply.at; run.durationMs = reply.durationMs; run.costUsd = reply.costUsd;
      run.preview = reply.text.slice(0, PREVIEW_CHARS);
      if (reply.isError) run.reason = reply.text;
      this.scheduleChanged(task);
      if (task.target.kind === 'newChat') queueMicrotask(() => this.archiveScheduleRuns(task));
      queueMicrotask(() => this.scheduler.drain());
    }
    this.cancelPermissions(rec.id, false);
    // A new keep-warm episode starts with this turn's cache.
    if (rec.warm) rec.warm = { nextAt: null, until: null, pings: 0, costUsd: 0, ...(rec.warm.last ? { last: rec.warm.last } : {}) };
    // A routed question: the expert's reply is its answer.
    if (handled.question && !reply.interrupted) {
      const set = this.questionSets.find((s) => s.id === handled.question!.setId);
      const q = set?.routed.find((x) => x.id === handled.question!.questionId);
      if (set && q) {
        q.answer = { text: reply.text, at: reply.at };
        set.updatedAt = reply.at;
        this.questionsChanged(set);
      }
    }
    const plan = handled.track ? this.plans.find((p) => p.id === handled.track!.planId) : undefined;
    if (plan && !reply.interrupted) {
      plan.replied[handled.track!.trackId] = reply.at;
      plan.updatedAt = reply.at;
      this.planChanged(plan);
    }
    if (handled.notify) {
      if (reply.interrupted) {
        this.notifyParent(rec, 'was interrupted by the user. Send it a message to continue.');
      } else {
        const preview = reply.text.length > PREVIEW_CHARS ? `${reply.text.slice(0, PREVIEW_CHARS)}…` : reply.text;
        const outcome = reply.isError ? 'finished its turn with an error' : 'finished its turn';
        const what = `${outcome}. Read the full reply with get_expert_output.\nPreview: ${preview}`;
        if (plan && plan.notify === 'round') {
          plan.held.push(this.notificationText(rec, what));
          this.planChanged(plan);
        } else {
          this.notifyParent(rec, what);
        }
      }
    }
    if (plan) this.checkRound(plan);
    // An orchestrator that ends its turn won't start more tracks: rounds waiting on that can complete.
    if (rec.kind === 'orchestrator') {
      for (const p of this.plans) if (p.orchestratorId === rec.id && p.held.length) this.checkRound(p);
    }
  }

  private notificationText(rec: AgentRecord, what: string): string {
    return `[Manager notification] Expert "${rec.name}" (id: ${rec.id}) ${what}`;
  }

  private notifyParent(rec: AgentRecord, what: string): void {
    if (!rec.parentId) return;
    this.enqueueNotification(rec.parentId, this.notificationText(rec, what));
  }

  private enqueueNotification(orchestratorId: string, text: string): void {
    if (!this.runtimes.has(orchestratorId)) return;
    this.unarchive(this.get(orchestratorId));
    const message: QueuedMessage = {
      id: newId('msg'),
      text,
      source: 'manager',
      notify: false,
      queuedAt: new Date().toISOString(),
    };
    this.runtime(orchestratorId).enqueue(message);
  }

  private agentEnv(): Record<string, string | undefined> {
    return agentEnvironment(process.env, { stripHostEnv: this.config.stripHostEnv, extra: this.config.env, remove: this.config.removeEnv });
  }

  private buildOptions(rec: AgentRecord): Options {
    if (!existsSync(rec.cwd) || !statSync(rec.cwd).isDirectory()) throw new Error(`The folder ${rec.cwd} does not exist anymore`);
    const options: Options = {
      cwd: rec.cwd,
      resume: rec.sessionId ?? undefined,
      title: rec.name,
      env: this.agentEnv(),
      permissionMode: this.config.permissionMode,
      allowDangerouslySkipPermissions: this.config.permissionMode === 'bypassPermissions',
      // What auto mode can't decide comes to the user (canUseTool) and waits for an answer.
      permissionPrompts: 'host',
      canUseTool: (...args) => this.askPermission(rec.id, ...args),
      // Every agent gets what its own folder (and the user's ~/.claude) sets up: CLAUDE.md, skills,
      // settings. A chat in the managing folder gets the orchestrate skill from its .claude/skills.
      settingSources: ['user', 'project', 'local'],
      skills: 'all',
      // One-line summaries of what running subagents do, on task_progress events (the UI's subagent line).
      agentProgressSummaries: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: this.instructions(rec) },
      stderr: (data) => process.stderr.write(`[${rec.id}] ${data}`),
    };
    // Saved on the record, so a resumed process (after idleMinutes or a restart) gets them back.
    const { model, effort } = this.runSettings(rec);
    if (model) options.model = model;
    if (effort) options.effort = effort;
    // Idle compaction would rewrite the conversation that keep-warm keeps cached (applies from the next process).
    if (keepWarmActive(rec)) options.settings = { idleCompaction: false };

    // Every agent can show visuals (show_visual); chats also get the manager tools.
    options.mcpServers = { display: createDisplayTools(this, rec.id) };
    options.allowedTools = ['mcp__display'];
    if (rec.kind === 'orchestrator') {
      options.mcpServers.centurion = createManagerTools(this, rec.id);
      options.allowedTools.push('mcp__centurion');
    } else if (rec.parentId) {
      // Experts read prompt files from and write findings to the orchestrator's folder, or their task's folder
      // when they have one. Other paths aren't blocked; the permission mode decides about them as usual.
      const parent = this.get(rec.parentId);
      if (rec.taskFolder) options.additionalDirectories = [rec.taskFolder];
      else if (parent.cwd !== rec.cwd) options.additionalDirectories = [parent.cwd];
    }
    return options;
  }

  /**
   * The instructions appended to an agent's system prompt: the chat's repo's `.centurion/prompts/<kind>.md` if it
   * has one (it replaces the packaged prompt as a whole), else the packaged one. The repo is a chat's own folder,
   * and an expert's chat's folder. A top-level chat (kind `orchestrator`) gets `orchestrator.md`; it becomes an
   * orchestrator through an orchestrate skill in its folder.
   */
  private instructions(rec: AgentRecord): string {
    const parent = rec.parentId ? this.get(rec.parentId) : null;
    const file = promptFile(this.config, rec.kind, (parent ?? rec).cwd);
    const template = file ? readFileSync(file, 'utf8') : '';
    const values: Record<PromptPlaceholder, string> = {
      id: rec.id,
      name: rec.name,
      cwd: rec.cwd,
      orchestratorName: parent?.name ?? '',
      orchestratorCwd: parent?.cwd ?? '',
      taskFolder: rec.taskFolder ?? parent?.cwd ?? '',
    };
    return template.replace(/\{\{(\w+)\}\}/g, (all, key: string) => (key in values ? values[key as PromptPlaceholder] : all));
  }

  private runtime(id: string): AgentRuntime {
    const rt = this.runtimes.get(id);
    if (!rt) throw new Error(`Unknown agent: ${id}`);
    return rt;
  }

  private changed(rec: AgentRecord): void {
    this.store.save(() => this.state());
    this.emit('agent', rec);
    // Keep-warm follows the record, and a chat's keep-warm also follows its experts' work.
    this.warmer.check(rec);
    const parent = rec.parentId ? this.runtimes.get(rec.parentId)?.rec : undefined;
    if (parent?.keepWarm?.experts) this.warmer.check(parent);
  }
}

/** A message that starts a turn: user text, not a tool result, an interrupt marker or command output. */
function isPrompt(m: SessionMessage): boolean {
  if (m.type !== 'user' || m.parent_tool_use_id) return false;
  const content = (m.message as { content?: unknown } | null)?.content;
  let text: string;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((b: { type?: string }) => b.type === 'tool_result')) return false;
    const first = content.find((b: { type?: string }) => b.type === 'text') as { text?: string } | undefined;
    if (!first) return content.some((b: { type?: string }) => b.type === 'image');
    text = String(first.text ?? '');
  } else return false;
  return !/^\s*(\[Request interrupted|<local-command-stdout>|<local-command-caveat>)/.test(text);
}

function timeOf(m: SessionMessage): number {
  const t = Date.parse(String((m as { timestamp?: unknown }).timestamp ?? ''));
  return Number.isNaN(t) ? Date.now() : t;
}

function toModelOption(m: ModelOption): ModelOption {
  return {
    value: m.value,
    ...(m.resolvedModel ? { resolvedModel: m.resolvedModel } : {}),
    displayName: m.displayName,
    description: m.description,
    ...(m.supportsEffort ? { supportsEffort: true, supportedEffortLevels: m.supportedEffortLevels ?? [] } : {}),
  };
}

/** The entry for an alias or id: an exact value first, then an entry that resolves to it. */
function findModel(list: ModelOption[], model: string): ModelOption | undefined {
  return (
    list.find((m) => m.value === model) ??
    list.find((m) => m.resolvedModel === model && m.value !== 'default') ??
    list.find((m) => m.resolvedModel === model)
  );
}

function supportsEffort(info: ModelOption, effort: EffortLevel): boolean {
  return !!info.supportsEffort && (info.supportedEffortLevels ?? []).includes(effort);
}

function effortError(info: ModelOption, effort: EffortLevel): string {
  return info.supportsEffort
    ? `${info.displayName} does not support effort "${effort}". Use one of: ${(info.supportedEffortLevels ?? []).join(', ')}.`
    : `${info.displayName} has no effort levels; leave effort out.`;
}

/** Whether two absolute paths name the same folder (case-insensitive on Windows). */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
}

function validateDir(dir: string): string {
  if (!dir || !path.isAbsolute(dir)) throw new Error(`Folder must be an absolute path: "${dir}"`);
  const resolved = path.resolve(dir);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) throw new Error(`Folder does not exist: ${resolved}`);
  return resolved;
}

/**
 * A task folder: absolute and inside the orchestrator's folder, links included. It must exist when
 * `mustExist` (an expert starts in it); a plan only names it, and the orchestrator creates it later.
 * Returns the real path of an existing folder.
 */
function checkTaskFolder(orchestratorCwd: string, folder: string, mustExist: boolean): string {
  if (!folder || !path.isAbsolute(folder)) throw new Error(`task_folder must be an absolute path: "${folder}"`);
  const resolved = path.resolve(folder);
  const exists = existsSync(resolved);
  if (exists && !statSync(resolved).isDirectory()) throw new Error(`task_folder is not a folder: ${resolved}`);
  if (!exists && mustExist) {
    throw new Error(`task_folder does not exist: ${resolved}. Create it first (write the prompt file there), then start the expert.`);
  }
  const real = exists ? realpathSync(resolved) : resolved;
  if (!isInside(realpathSync(orchestratorCwd), real)) {
    throw new Error(`task_folder must be inside your folder (${orchestratorCwd}): ${resolved}`);
  }
  return real;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
}

function newId(prefix: string): string {
  return `${prefix}-${randomBytes(3).toString('hex')}`;
}

/** The placeholders a prompt file may use, each filled in per agent. */
export const PROMPT_PLACEHOLDERS = {
  id: "The agent's id",
  name: "The agent's name",
  cwd: "The agent's folder (absolute)",
  orchestratorName: "The name of the agent's chat (empty for a chat)",
  orchestratorCwd: "The folder of the agent's chat (empty for a chat): where task files usually go",
  taskFolder:
    "The folder of the expert's task: the one place besides its own folder where it reads prompts and writes findings. The chat's folder when the task has no folder of its own (empty for a chat)",
} as const;

export type PromptPlaceholder = keyof typeof PROMPT_PLACEHOLDERS;

/**
 * The prompt file used for a kind of agent whose chat runs in `chatFolder`: that repo's replacement, else the
 * packaged one, else none. The default chat folder's replacements are `repoPromptsDir` (next to the config);
 * any other folder's are `<folder>/.centurion/prompts`.
 */
export function promptFile(
  config: Pick<Config, 'repoPromptsDir' | 'promptsDir' | 'orchestratorFolder'>,
  kind: string,
  chatFolder: string,
): string | null {
  const repoDir = samePath(chatFolder, config.orchestratorFolder) ? config.repoPromptsDir : path.join(chatFolder, '.centurion', 'prompts');
  for (const dir of [repoDir, config.promptsDir]) {
    const file = path.join(dir, `${kind}.md`);
    if (existsSync(file)) return file;
  }
  return null;
}
