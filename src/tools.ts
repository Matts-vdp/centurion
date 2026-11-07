import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { packageVersion } from './paths.js';
import type { Manager } from './manager.js';
import { EFFORT_LEVELS, type AgentRecord, type EffortLevel } from './types.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** Added to create_expert / message_expert results: the chat already shows the delegation. */
const SHOWN_DELEGATION = 'The user sees this in the chat. Don\'t restate the task in your reply.';

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown): ToolResult {
  return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
}

function summary(rec: AgentRecord) {
  return {
    id: rec.id,
    name: rec.name,
    folder: rec.cwd,
    status: rec.status,
    model: rec.model ?? rec.activeModel ?? 'default',
    effort: rec.effort ?? rec.activeEffort ?? 'model default',
    queued: rec.queue.length,
    replies: rec.replies.length,
    lastError: rec.lastError,
    archived: rec.archived,
  };
}

/** The tools an orchestrator uses to manage its experts (the `centurion` server's tools). */
export function managerTools(manager: Manager, orchestratorId: string) {
  const ownExpert = (id: string): AgentRecord => {
    const rec = manager.get(id);
    if (rec.parentId !== orchestratorId) throw new Error(`Expert ${id} does not belong to you`);
    return rec;
  };

  const guard =
    <A>(fn: (args: A) => ToolResult | Promise<ToolResult>) =>
    async (args: A): Promise<ToolResult> => {
      try {
        return await fn(args);
      } catch (err) {
        return fail(err);
      }
    };

  return [
  tool(
    'create_expert',
    'Start a new expert agent in a folder. It runs as its own Claude session in that folder, with that folder\'s ' +
      'settings and MCP servers. Omit `folder` to start it in your own folder (useful for web research or MCP-only work). ' +
      'If you pass `message`, the expert starts working on it right away. Leave `model` and `effort` out unless the ' +
      'task clearly needs something else: the expert then runs on the same model and effort as you (or as its plan ' +
      'track says). The user sees the expert start in the chat, with its task, so don\'t restate the task in your reply.',
    {
      name: z.string().describe('Short name, e.g. "api-research"'),
      folder: z.string().optional().describe('Absolute path of the folder the expert works in. Defaults to your own folder.'),
      message: z.string().optional().describe('First task for the expert'),
      notify: z.boolean().optional().describe('Wake you with a notification when it finishes this message. Default true.'),
      track_id: z.string().optional().describe('The id of the plan track this expert works on (from propose_tracks)'),
      model: z
        .string()
        .optional()
        .describe('Model alias (haiku, sonnet, opus, fable) or id. Default: the track\'s model, else yours.'),
      effort: z.enum(EFFORT_LEVELS as [EffortLevel, ...EffortLevel[]]).optional().describe('Default: the track\'s effort, else yours.'),
    },
    guard((args) => {
      const rec = manager.createExpert(orchestratorId, {
        name: args.name,
        cwd: args.folder,
        message: args.message,
        notify: args.notify ?? true,
        trackId: args.track_id,
        model: args.model,
        effort: args.effort,
      });
      return ok({ ...summary(rec), note: SHOWN_DELEGATION });
    }),
  ),
  tool(
    'message_expert',
    'Send a message to one of your experts. It is queued and handled after any earlier messages; this tool returns ' +
      'immediately. With notify (default true) you get a notification when the expert has handled it; then read the ' +
      'answer with get_expert_output. The user sees the message in the chat, so don\'t restate it in your reply.',
    {
      expert_id: z.string(),
      message: z.string(),
      notify: z.boolean().optional().describe('Default true'),
      track_id: z.string().optional().describe('The plan track this message starts or continues (from propose_tracks)'),
      question_id: z.string().optional().describe('The routed question this message asks (from ask_user `routed`)'),
    },
    guard((args) => {
      const rec = ownExpert(args.expert_id);
      manager.messageExpert(orchestratorId, rec.id, {
        message: args.message,
        notify: args.notify ?? true,
        trackId: args.track_id,
        questionId: args.question_id,
      });
      return ok({ accepted: true, ...summary(manager.get(rec.id)), note: SHOWN_DELEGATION });
    }),
  ),
  tool(
    'get_expert_output',
    'Read the final reply of an expert\'s last turns (its answer text, without tool calls). Works for replies to your ' +
      'messages and to messages the user sent the expert directly.',
    {
      expert_id: z.string(),
      last_n: z.number().int().min(1).max(20).optional().describe('How many recent replies, newest last. Default 1.'),
    },
    guard((args) => {
      const rec = ownExpert(args.expert_id);
      const n = args.last_n ?? 1;
      return ok({
        ...summary(rec),
        note: rec.status === 'running' ? 'The expert is still working; these replies are from earlier turns.' : undefined,
        output: rec.replies.slice(-n),
      });
    }),
  ),
  tool(
    'propose_tracks',
    'Propose the tracks of a round to the user: experts in other repos, an expert in your folder, or subagent work of ' +
      'your own, to run in parallel. The user sees them as a plan they can start (all or some) or answer in the chat. ' +
      'Returns immediately; end your turn after calling it and wait. Calling it again for the same round replaces ' +
      'the plan with a new version (do that when the user asks for changes). `later` outlines the rounds you expect ' +
      'after this one, for information only. The user sees the plan exactly as you pass it, so don\'t list the tracks, ' +
      'their summaries or the later rounds in your reply: at most one short line, or what the plan can\'t show (why ' +
      'this split, what you are unsure of).',
    {
      round: z.number().int().min(1),
      title: z.string().describe('What this round is about, in a few words'),
      tracks: z
        .array(
          z.object({
            id: z.string().describe('Short id, e.g. "t1". Pass it as track_id when you start the track.'),
            title: z.string(),
            summary: z.string().describe('One or two sentences for the user. Not the handoff prompt.'),
            target: z.discriminatedUnion('kind', [
              z.object({ kind: z.literal('new_expert'), name: z.string(), folder: z.string().optional() }),
              z.object({ kind: z.literal('existing_expert'), expertId: z.string() }),
              z.object({ kind: z.literal('subagent') }),
            ]),
            model: z.string().optional().describe('Only when the track needs a different model than yours, e.g. haiku for a log scan'),
            effort: z.enum(EFFORT_LEVELS as [EffortLevel, ...EffortLevel[]]).optional().describe('Only when it needs a different effort than yours'),
          }),
        )
        .min(1),
      later: z
        .array(
          z.object({
            round: z.number().int(),
            title: z.string(),
            tracks: z.array(z.object({ title: z.string(), summary: z.string().optional() })),
          }),
        )
        .optional(),
    },
    guard((args) => {
      const plan = manager.proposeTracks(orchestratorId, args);
      return ok({
        planId: plan.id,
        round: plan.round,
        version: plan.versions.length,
        status:
          'Shown to the user. Don\'t repeat the tracks in your reply. End your turn now. You will get a message saying which tracks to start, or the user will answer in the chat.',
      });
    }),
  ),
  tool(
    'ask_user',
    'Ask the user the questions you cannot settle yourself, as one set they answer with clicks. Include the questions ' +
      'you answered yourself (`resolved`, with where the answer came from) and the ones you sent to an expert in another ' +
      'repo (`routed`; also send each with message_expert and its question_id), so the user sees all of them. Give ' +
      'options when there are clear choices and mark the one you prefer as suggested. Returns immediately; end your ' +
      'turn after calling it. The answers arrive as one message. The user sees the questions, options and context as ' +
      'you pass them, so don\'t repeat them in your reply: at most one short line.',
    {
      title: z.string().describe('E.g. "Questions from round 1"'),
      questions: z
        .array(
          z.object({
            id: z.string(),
            from: z.string().optional().describe('Id of the expert that raised it'),
            question: z.string(),
            context: z.string().optional().describe('One or two sentences: why it matters, what each choice means'),
            kind: z.enum(['single', 'multi', 'text']).optional().describe('Default: single with options, else text'),
            options: z
              .array(z.object({ label: z.string(), detail: z.string().optional(), suggested: z.boolean().optional() }))
              .optional(),
          }),
        )
        .min(1),
      resolved: z
        .array(z.object({ id: z.string(), from: z.string().optional(), question: z.string(), answer: z.string(), source: z.string().optional() }))
        .optional(),
      routed: z.array(z.object({ id: z.string(), from: z.string().optional(), question: z.string(), expertId: z.string() })).optional(),
    },
    guard((args) => {
      const set = manager.askUser(orchestratorId, args);
      return ok({
        questionSetId: set.id,
        status:
          'Shown to the user. Don\'t repeat the questions in your reply. Send the routed questions with message_expert (question_id), then end your turn.',
      });
    }),
  ),
  tool(
    'list_experts',
    'List your experts with their status.',
    {},
    guard(() => ok(manager.childrenOf(orchestratorId).map(summary))),
  ),
  tool(
    'stop_expert',
    'Stop an expert: cancels its current turn and clears its queue. Sending it a new message later resumes the same session.',
    { expert_id: z.string() },
    guard(async (args) => {
      const rec = ownExpert(args.expert_id);
      await manager.stop(rec.id, 'orchestrator');
      return ok(summary(manager.get(rec.id)));
    }),
  ),
  ];
}

/** The `centurion` tool server for one orchestrator. */
export function createManagerTools(manager: Manager, orchestratorId: string): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: 'centurion', version: packageVersion, alwaysLoad: true, tools: managerTools(manager, orchestratorId) });
}
