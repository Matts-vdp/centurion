import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { getSessionMessages, type Options, type SDKMessage, type SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { AgentRuntime } from './agent.js';
import type { Config } from './config.js';
import { StateStore } from './state.js';
import { createManagerTools } from './tools.js';
import type { AgentKind, AgentRecord, MessageSource, QueuedMessage, Reply } from './types.js';

const PREVIEW_CHARS = 300;

export type ManagerEvents = {
  agent: [AgentRecord];
  message: [{ agentId: string; message: SDKMessage }];
};

export class Manager extends EventEmitter<ManagerEvents> {
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly store: StateStore;

  constructor(private readonly config: Config) {
    super();
    this.store = new StateStore(config.stateFile);
    const interrupted = this.store.load().filter((rec) => this.recover(rec));
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

  /** Full transcript from Claude's own session files. */
  async history(id: string): Promise<SessionMessage[]> {
    const rec = this.get(id);
    if (!rec.sessionId) return [];
    return getSessionMessages(rec.sessionId, { dir: rec.cwd });
  }

  // ---------- commands ----------

  createOrchestrator(input: { name: string; cwd: string; message?: string }): AgentRecord {
    const rec = this.createAgent('orchestrator', input.name, input.cwd, null);
    if (input.message) this.sendMessage(rec.id, input.message, 'user', false);
    return rec;
  }

  createExpert(
    parentId: string,
    input: { name: string; cwd?: string; message?: string; notify?: boolean },
  ): AgentRecord {
    const parent = this.get(parentId);
    if (parent.kind !== 'orchestrator') throw new Error('Only orchestrators can create experts');
    const rec = this.createAgent('expert', input.name, input.cwd ?? parent.cwd, parent.id);
    if (input.message) this.sendMessage(rec.id, input.message, 'orchestrator', input.notify ?? true);
    return rec;
  }

  sendMessage(id: string, text: string, source: MessageSource, notify: boolean): QueuedMessage {
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
    };
    rt.enqueue(message);
    return message;
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
    this.store.writeNow(this.list());
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
      costUsd: 0,
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
        onTurnEnd: (r, handled, reply) => this.onTurnEnd(r, handled, reply),
        onChange: (r) => this.changed(r),
      }),
    );
  }

  private onTurnEnd(rec: AgentRecord, handled: QueuedMessage, reply: Reply): void {
    if (!handled.notify) return;
    const preview = reply.text.length > PREVIEW_CHARS ? `${reply.text.slice(0, PREVIEW_CHARS)}…` : reply.text;
    const outcome = reply.isError ? 'finished its turn with an error' : 'finished its turn';
    this.notifyParent(rec, `${outcome}. Read the full reply with get_expert_output.\nPreview: ${preview}`);
  }

  private notifyParent(rec: AgentRecord, what: string): void {
    if (!rec.parentId || !this.runtimes.has(rec.parentId)) return;
    const message: QueuedMessage = {
      id: newId('msg'),
      text: `[Manager notification] Expert "${rec.name}" (id: ${rec.id}) ${what}`,
      source: 'manager',
      notify: false,
      queuedAt: new Date().toISOString(),
    };
    this.runtime(rec.parentId).enqueue(message);
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
    this.store.save(() => this.list());
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
