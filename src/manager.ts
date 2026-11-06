import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { getSessionMessages, type Options, type SDKMessage, type SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { AgentRuntime } from './agent.js';
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
import { StateStore, type State } from './state.js';
import { createManagerTools } from './tools.js';
import type { AgentKind, AgentRecord, MessageSource, Plan, QuestionSet, QueuedMessage, Reply } from './types.js';

const PREVIEW_CHARS = 300;

export type ManagerEvents = {
  agent: [AgentRecord];
  message: [{ agentId: string; message: SDKMessage }];
  delivered: [{ agentId: string; message: QueuedMessage }];
  plan: [Plan];
  questions: [QuestionSet];
};

/** Extra links a message can carry: the plan track or the routed question it belongs to. */
type MessageLinks = Pick<QueuedMessage, 'track' | 'question'>;

export class Manager extends EventEmitter<ManagerEvents> {
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly store: StateStore;
  private plans: Plan[];
  private questionSets: QuestionSet[];

  constructor(private readonly config: Config) {
    super();
    this.store = new StateStore(config.stateFile);
    const state = this.store.load();
    this.plans = state.plans;
    this.questionSets = state.questionSets;
    const interrupted = state.agents.filter((rec) => this.recover(rec));
    // Parents are all loaded now, so their notifications have somewhere to go.
    for (const rec of interrupted) {
      this.notifyParent(rec, 'was interrupted because the manager restarted. Send it a message to continue.');
    }
    for (const rt of this.runtimes.values()) rt.pump();
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

  /** Full transcript from Claude's own session files. */
  async history(id: string): Promise<SessionMessage[]> {
    const rec = this.get(id);
    if (!rec.sessionId) return [];
    return getSessionMessages(rec.sessionId, { dir: rec.cwd });
  }

  // ---------- commands ----------

  /** Orchestrators all run in the configured `orchestratorFolder`. */
  createOrchestrator(input: { name: string; message?: string }): AgentRecord {
    const rec = this.createAgent('orchestrator', input.name, this.config.orchestratorFolder, null);
    if (input.message) this.sendMessage(rec.id, input.message, 'user', false);
    return rec;
  }

  createExpert(
    parentId: string,
    input: { name: string; cwd?: string; message?: string; notify?: boolean; trackId?: string },
  ): AgentRecord {
    const parent = this.get(parentId);
    if (parent.kind !== 'orchestrator') throw new Error('Only orchestrators can create experts');
    const track = input.trackId ? this.findTrack(parentId, input.trackId) : undefined;
    const rec = this.createAgent('expert', input.name, input.cwd ?? parent.cwd, parent.id);
    if (track) this.linkTrack(track, rec.id);
    if (input.message) this.sendMessage(rec.id, input.message, 'orchestrator', input.notify ?? true, { track });
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

  sendMessage(id: string, text: string, source: MessageSource, notify: boolean, links: MessageLinks = {}): QueuedMessage {
    const rt = this.runtime(id);
    if (!text.trim()) throw new Error('Message is empty');
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
    };
    // A message to an archived expert brings it back into the tree.
    if (rt.rec.archived) rt.rec.archived = false;
    rt.enqueue(message);
    return message;
  }

  /** Cancel the running turn but keep the queue; the next queued message is delivered afterwards. */
  async interrupt(id: string): Promise<void> {
    if (!(await this.runtime(id).interrupt())) throw new Error('The agent is not running');
  }

  removeQueued(id: string, messageId: string): void {
    if (!this.runtime(id).removeQueued(messageId)) throw new Error('That message is no longer queued');
  }

  setArchived(id: string, archived: boolean): AgentRecord {
    const rt = this.runtime(id);
    if (rt.rec.kind !== 'expert') throw new Error('Only experts can be archived');
    if (archived && (rt.isBusy || rt.rec.queue.length > 0)) throw new Error('Cannot archive a running agent');
    rt.rec.archived = archived;
    this.changed(rt.rec);
    return rt.rec;
  }

  async stop(id: string, by: MessageSource): Promise<void> {
    const rt = this.runtime(id);
    const handled = await rt.stop();
    if (handled?.notify && by !== 'orchestrator') {
      this.notifyParent(rt.rec, `was stopped by the ${by} before finishing its turn.`);
    }
  }

  shutdown(): void {
    for (const rt of this.runtimes.values()) rt.dispose();
    this.store.writeNow(this.state());
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
    if (plan.status !== 'waiting') throw new Error('This plan was already started');
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
    const orchIdle = !orch || (!orch.isBusy && orch.rec.queue.length === 0);
    if (allStarted || orchIdle) this.releaseHeld(plan);
  }

  private releaseHeld(plan: Plan): void {
    if (plan.held.length === 0) return;
    const held = plan.held;
    plan.held = [];
    const v = currentVersion(plan);
    const n = Object.keys(plan.experts).length;
    this.enqueueNotification(
      plan.orchestratorId,
      `[Manager notification] Round ${plan.round} of "${v.title}": all ${n} started track${n === 1 ? '' : 's'} replied.`,
    );
    for (const text of held) this.enqueueNotification(plan.orchestratorId, text);
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
    return { agents: this.list(), plans: this.plans, questionSets: this.questionSets };
  }

  // ---------- internals ----------

  private createAgent(kind: AgentKind, name: string, cwd: string, parentId: string | null): AgentRecord {
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
      lastActivityAt: now,
      context: null,
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
        onMessage: (r, message) => this.emit('message', { agentId: r.id, message }),
        onDeliver: (r, message) => this.emit('delivered', { agentId: r.id, message }),
        onTurnEnd: (r, handled, reply) => this.onTurnEnd(r, handled, reply),
        onChange: (r) => this.changed(r),
      }, this.config.idleMinutes * 60_000),
    );
  }

  private onTurnEnd(rec: AgentRecord, handled: QueuedMessage, reply: Reply): void {
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
    const message: QueuedMessage = {
      id: newId('msg'),
      text,
      source: 'manager',
      notify: false,
      queuedAt: new Date().toISOString(),
    };
    this.runtime(orchestratorId).enqueue(message);
  }

  private buildOptions(rec: AgentRecord): Options {
    const env: Record<string, string | undefined> = { ...process.env, ...this.config.env };
    for (const key of this.config.removeEnv) delete env[key];

    const options: Options = {
      cwd: rec.cwd,
      resume: rec.sessionId ?? undefined,
      title: rec.name,
      env,
      permissionMode: this.config.permissionMode,
      allowDangerouslySkipPermissions: this.config.permissionMode === 'bypassPermissions',
      // Nobody sits behind a prompt: anything auto mode can't decide is denied and the agent adapts.
      permissionPrompts: 'none',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: this.instructions(rec) },
      stderr: (data) => process.stderr.write(`[${rec.id}] ${data}`),
    };
    if (this.config.model) options.model = this.config.model;

    if (rec.kind === 'orchestrator') {
      options.mcpServers = { manager: createManagerTools(this, rec.id) };
      options.allowedTools = ['mcp__manager'];
    } else if (rec.parentId) {
      // Experts read prompt files from and write findings to the orchestrator's folder.
      const parent = this.get(rec.parentId);
      if (parent.cwd !== rec.cwd) options.additionalDirectories = [parent.cwd];
    }
    return options;
  }

  private instructions(rec: AgentRecord): string {
    const file = path.join(this.config.promptsDir, `${rec.kind}.md`);
    const template = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const parent = rec.parentId ? this.get(rec.parentId) : null;
    return template
      .replaceAll('{{id}}', rec.id)
      .replaceAll('{{name}}', rec.name)
      .replaceAll('{{cwd}}', rec.cwd)
      .replaceAll('{{orchestratorName}}', parent?.name ?? '')
      .replaceAll('{{orchestratorCwd}}', parent?.cwd ?? '');
  }

  private runtime(id: string): AgentRuntime {
    const rt = this.runtimes.get(id);
    if (!rt) throw new Error(`Unknown agent: ${id}`);
    return rt;
  }

  private changed(rec: AgentRecord): void {
    this.store.save(() => this.state());
    this.emit('agent', rec);
  }
}

function validateDir(dir: string): string {
  if (!dir || !path.isAbsolute(dir)) throw new Error(`Folder must be an absolute path: "${dir}"`);
  const resolved = path.resolve(dir);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) throw new Error(`Folder does not exist: ${resolved}`);
  return resolved;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
}

function newId(prefix: string): string {
  return `${prefix}-${randomBytes(3).toString('hex')}`;
}
