import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Manager } from './manager.js';
import type { AgentRecord } from './types.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

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
    queued: rec.queue.length,
    replies: rec.replies.length,
    lastError: rec.lastError,
    archived: rec.archived,
  };
}

/** The tools an orchestrator uses to manage its experts. One server per orchestrator. */
export function createManagerTools(manager: Manager, orchestratorId: string): McpSdkServerConfigWithInstance {
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

  return createSdkMcpServer({
    name: 'manager',
    version: '0.1.0',
    alwaysLoad: true,
    tools: [
      tool(
        'create_expert',
        'Start a new expert agent in a folder. It runs as its own Claude session in that folder, with that folder\'s ' +
          'settings and MCP servers. Omit `folder` to start it in your own folder (useful for web research or MCP-only work). ' +
          'If you pass `message`, the expert starts working on it right away.',
        {
          name: z.string().describe('Short name, e.g. "api-research"'),
          folder: z.string().optional().describe('Absolute path of the folder the expert works in. Defaults to your own folder.'),
          message: z.string().optional().describe('First task for the expert'),
          notify: z.boolean().optional().describe('Wake you with a notification when it finishes this message. Default true.'),
        },
        guard((args) => {
          const rec = manager.createExpert(orchestratorId, {
            name: args.name,
            cwd: args.folder,
            message: args.message,
            notify: args.notify ?? true,
          });
          return ok(summary(rec));
        }),
      ),
      tool(
        'message_expert',
        'Send a message to one of your experts. It is queued and handled after any earlier messages; this tool returns ' +
          'immediately. With notify (default true) you get a notification when the expert has handled it; then read the ' +
          'answer with get_expert_output.',
        {
          expert_id: z.string(),
          message: z.string(),
          notify: z.boolean().optional().describe('Default true'),
        },
        guard((args) => {
          const rec = ownExpert(args.expert_id);
          manager.sendMessage(rec.id, args.message, 'orchestrator', args.notify ?? true);
          return ok({ accepted: true, ...summary(manager.get(rec.id)) });
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
    ],
  });
}
