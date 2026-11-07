import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from './config.js';
import type { Manager } from './manager.js';
import { apiJson, apiMarkdown } from './docs.js';
import { packageVersion } from './paths.js';
import { allFiles, FileError, fileDiff, gitStatus, listFolder, RawBody, readFileContent, repoInfo } from './files.js';
import { EFFORT_LEVELS, IMAGE_TYPES, type EffortLevel, type ImageData, type PermissionDecision } from './types.js';

const MAX_BODY = 1024 * 1024;
/** Messages can carry images: up to MAX_IMAGES of at most 5 MB of base64 each (the API's limit). */
const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_MESSAGE_BODY = MAX_IMAGES * MAX_IMAGE_BYTES + MAX_BODY;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Only forward what a transcript view needs; the SDK emits many internal events. */
function forward(message: SDKMessage): boolean {
  if (message.type === 'assistant' || message.type === 'user' || message.type === 'result') return true;
  if (message.type === 'system') {
    return ['init', 'permission_denied', 'compact_boundary', 'api_retry', 'task_started', 'task_progress', 'task_notification'].includes(
      message.subtype as string,
    );
  }
  return false;
}

export function startServer(manager: Manager, config: Config): http.Server {
  const clients = new Set<http.ServerResponse>();
  const broadcast = (event: string, data: unknown) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(frame);
  };

  manager.on('agent', (rec) => broadcast('agent', rec));
  manager.on('delivered', (data) => broadcast('delivered', data));
  manager.on('plan', (plan) => broadcast('plan', plan));
  manager.on('questions', (set) => broadcast('questions', set));
  manager.on('permission', (request) => broadcast('permission', request));
  manager.on('message', (data) => {
    if (forward(data.message)) broadcast('message', data);
  });

  const authorized = (req: http.IncomingMessage, url: URL): boolean => {
    if (!config.token) return true;
    const header = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const given = Buffer.from(header ?? url.searchParams.get('token') ?? '');
    const expected = Buffer.from(config.token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const openStream = (req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`event: snapshot\ndata: ${JSON.stringify(manager.list())}\n\n`);
    for (const plan of manager.listPlans()) res.write(`event: plan\ndata: ${JSON.stringify(plan)}\n\n`);
    for (const set of manager.listQuestionSets()) res.write(`event: questions\ndata: ${JSON.stringify(set)}\n\n`);
    for (const request of manager.listPermissions()) res.write(`event: permission\ndata: ${JSON.stringify(request)}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(404, 'Not found');
        await serveUi(config.uiDir, url.pathname, res);
        return;
      }
      if (!authorized(req, url)) throw new HttpError(401, 'Missing or wrong token');

      const result = await dispatch(req, url, { manager, config, openStream: () => openStream(req, res) });
      if (result === STREAMED) return;
      if (result instanceof RawBody) {
        // Never let a served file (an SVG with a script, say) run in the UI's origin.
        res
          .writeHead(200, {
            'content-type': result.type,
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            'x-content-type-options': 'nosniff',
            'cache-control': 'no-cache',
          })
          .end(result.body);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (err) {
      const status = err instanceof HttpError || err instanceof FileError ? err.status : 400;
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
  });

  server.listen(config.port, config.host, () => {
    const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
    const token = config.token ? `?token=${encodeURIComponent(config.token)}` : '';
    console.log(`Centurion listening on http://${shown}:${config.port}/${token}`);
    console.log(`Permission mode: ${config.permissionMode}. State: ${config.stateFile}`);
    console.log(`Orchestrators run in: ${config.orchestratorFolder}`);
  });
  return server;
}

/** What a route handler gets: the matched path params, the URL, the parsed JSON body, the manager and the config. */
export type RouteContext = {
  params: Record<string, string>;
  url: URL;
  /** The parsed JSON body; `{}` when the route takes none or none was sent. */
  body: Record<string, any>;
  manager: Manager;
  config: Config;
  /** Turns the response into the event stream (only `GET /api/events` uses it). */
  openStream: () => void;
};

export type RouteDoc = {
  method: 'GET' | 'POST' | 'DELETE';
  /** Path pattern; `:name` segments are params. */
  path: string;
  /** One line on what it does. */
  summary: string;
  /** Query parameters, when it takes any. */
  query?: string;
  /** The JSON request body, when it takes one. */
  body?: string;
  result: string;
};

export type Route = RouteDoc & {
  /** Largest body accepted, in bytes (default 1 MB). */
  maxBody?: number;
  handler: (ctx: RouteContext) => unknown;
};

/** Returned by a handler that wrote the response itself. */
const STREAMED = Symbol('streamed');

const AGENT = 'The agent record';

/** Every API route. The server dispatches from this table, and `describeRoutes()` documents it. */
export const routes: Route[] = [
  {
    method: 'GET',
    path: '/api/events',
    summary: 'Server-sent events: a snapshot, then every change (the events are listed below the endpoints)',
    result:
      'An event stream: `snapshot`, then all plans, question sets and permission requests, then live events; a `: ping` comment every 25 s',
    handler: ({ openStream }) => {
      openStream();
      return STREAMED;
    },
  },
  {
    method: 'GET',
    path: '/api/info',
    summary: 'Server settings the UI needs, and the version',
    result: '`{ version, permissionMode, orchestratorFolder, platform, defaultModel }`',
    handler: ({ config }) => ({
      version: packageVersion,
      permissionMode: config.permissionMode,
      orchestratorFolder: config.orchestratorFolder,
      platform: process.platform,
      defaultModel: config.model,
    }),
  },
  {
    method: 'GET',
    path: '/api/docs',
    summary: 'This API documented: the same text as `centurion api`',
    query: '`format=json` for data (`{ version, auth, deepLink, routes, events }`); default Markdown',
    result: 'Markdown (`text/markdown`), or JSON with `format=json`',
    handler: ({ url }) =>
      url.searchParams.get('format') === 'json' ? apiJson() : new RawBody('text/markdown; charset=utf-8', Buffer.from(apiMarkdown())),
  },
  {
    method: 'GET',
    path: '/api/models',
    summary: 'Supported models (cached; learned from the first agent process, or from a process started just to ask)',
    result: '`{ value, resolvedModel?, displayName, description, supportsEffort?, supportedEffortLevels? }[]`',
    handler: ({ manager }) => manager.models(),
  },
  {
    method: 'GET',
    path: '/api/plans',
    summary: 'All track plans',
    result: 'Plan[]',
    handler: ({ manager }) => manager.listPlans(),
  },
  {
    method: 'POST',
    path: '/api/plans/:id/start',
    summary: 'Starts a plan: sends the orchestrator only the chosen track ids',
    body: '`{ start: trackIds, skip?: trackIds }`',
    result: 'The plan',
    handler: ({ manager, params, body }) => manager.startPlan(params.id, strings(body.start, 'start'), strings(body.skip ?? [], 'skip')),
  },
  {
    method: 'POST',
    path: '/api/plans/:id/notify',
    summary: "Sets how a plan's track replies reach the orchestrator: per round or each one",
    body: "`{ mode: 'round' | 'each' }`",
    result: 'The plan',
    handler: ({ manager, params, body }) => {
      if (body.mode !== 'round' && body.mode !== 'each') throw new HttpError(400, '"mode" must be "round" or "each"');
      return manager.setPlanNotify(params.id, body.mode);
    },
  },
  {
    method: 'GET',
    path: '/api/questions',
    summary: 'All question sets',
    result: 'QuestionSet[]',
    handler: ({ manager }) => manager.listQuestionSets(),
  },
  {
    method: 'POST',
    path: '/api/questions/:id/answer',
    summary: 'Answers a question set',
    body: '`{ answers: [{ questionId, choices?, text? }], corrections?: [{ questionId, text }] }`',
    result: 'The question set',
    handler: ({ manager, params, body }) => {
      const answers = list(body.answers, 'answers').map((a) => ({
        questionId: str(a.questionId, 'questionId'),
        choices: a.choices === undefined ? [] : strings(a.choices, 'choices'),
        text: typeof a.text === 'string' ? a.text : '',
      }));
      const corrections = list(body.corrections ?? [], 'corrections').map((c) => ({
        questionId: str(c.questionId, 'questionId'),
        text: str(c.text, 'text'),
      }));
      return manager.answerQuestions(params.id, answers, corrections);
    },
  },
  {
    method: 'GET',
    path: '/api/agents',
    summary: 'All agents',
    result: 'AgentRecord[]',
    handler: ({ manager }) => manager.list(),
  },
  {
    method: 'POST',
    path: '/api/agents',
    summary: 'Creates a chat in `orchestratorFolder`',
    body: '`{ name, message? }`',
    result: 'The new agent record',
    handler: ({ manager, body }) => manager.createOrchestrator({ name: str(body.name, 'name'), message: optionalText(body.message) }),
  },
  {
    method: 'GET',
    path: '/api/agents/:id',
    summary: 'One agent',
    result: AGENT,
    handler: ({ manager, params }) => manager.get(params.id),
  },
  {
    method: 'GET',
    path: '/api/agents/:id/history',
    summary: "The agent's transcript, from Claude's session file",
    result: 'HistoryMessage[]',
    handler: ({ manager, params }) => manager.history(params.id),
  },
  {
    method: 'GET',
    path: '/api/agents/:id/commands',
    summary:
      "The skills and custom commands the agent's folder offers (Claude Code's own commands left out; cached per folder, learned from the agent processes or a process started just to ask)",
    result: '`{ name, description, argumentHint }[]`',
    handler: ({ manager, params }) => manager.commands(params.id),
  },
  {
    method: 'GET',
    path: '/api/agents/:id/subagents/:toolUseId',
    summary: 'The transcript of the subagent started by that Agent / Task call',
    result: 'HistoryMessage[]',
    handler: ({ manager, params }) => manager.subagentHistory(params.id, params.toolUseId),
  },
  {
    method: 'GET',
    path: '/api/agents/:id/files/roots',
    summary: "The folders the Files panel may show: the agent's, then its orchestrator's when that differs",
    result: '`{ roots: [{ name, path, git }] }`; `root` in the other file routes is an index into this list',
    handler: async ({ manager, params }) => {
      const roots = rootsOf(manager, params.id);
      return { roots: await Promise.all(roots.map(async (r) => ({ ...r, git: (await repoInfo(r.path)) !== null }))) };
    },
  },
  {
    method: 'GET',
    path: '/api/agents/:id/files/list',
    summary: 'One folder (at most 5000 entries)',
    query: '`root`, `path`',
    result: '`{ entries: [{ name, type, size, mtime, ignored, git?, changes? }], truncated }`',
    handler: (ctx) => {
      const { root, rel } = fileRoot(ctx);
      return listFolder(root, rel);
    },
  },
  {
    method: 'GET',
    path: '/api/agents/:id/files/all',
    summary: 'Every tracked and untracked path (a walk outside git), at most 50000',
    query: '`root`',
    result: '`{ files, truncated }`',
    handler: (ctx) => allFiles(fileRoot(ctx).root),
  },
  {
    method: 'GET',
    path: '/api/agents/:id/files/read',
    summary: "One file (text: the first 1 MB); `raw=1` returns an image's bytes",
    query: '`root`, `path`, `raw?`',
    result: "`{ kind: 'text', text, size, lines, truncated }`, `{ kind: 'image', mediaType, size }` or `{ kind: 'binary', size }`",
    handler: (ctx) => {
      const { root, rel } = fileRoot(ctx);
      return readFileContent(root, rel, ctx.url.searchParams.get('raw') === '1');
    },
  },
  {
    method: 'GET',
    path: '/api/agents/:id/git/status',
    summary: 'Git status of a root',
    query: '`root`',
    result: '`{ status: { branch, ahead, behind, files: [{ path, status, added, removed }] } }`, or `{ status: null }` outside git',
    handler: async (ctx) => ({ status: await gitStatus(fileRoot(ctx).root, true) }),
  },
  {
    method: 'GET',
    path: '/api/agents/:id/git/diff',
    summary: "A file's hunks against `HEAD` (untracked: all added); 400 outside git",
    query: '`root`, `path`',
    result: '`{ diff, status, binary, truncated }`',
    handler: (ctx) => {
      const { root, rel } = fileRoot(ctx);
      if (!rel) throw new HttpError(400, '"path" is required');
      return fileDiff(root, rel);
    },
  },
  {
    method: 'POST',
    path: '/api/agents/:id/experts',
    summary: "Starts an expert under a chat for the user; the chat isn't notified",
    body: '`{ name, cwd?, message? }`',
    result: 'The new agent record',
    handler: ({ manager, params, body }) => {
      const cwd = typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : undefined;
      return manager.createExpert(params.id, { name: str(body.name, 'name'), cwd, message: optionalText(body.message) }, 'user');
    },
  },
  {
    method: 'POST',
    path: '/api/agents/:id/fork',
    summary: 'Copies the conversation up to the end of that turn into a new agent (same kind, folder, parent, model)',
    body: '`{ promptUuid }`',
    result: 'The new agent record',
    handler: ({ manager, params, body }) => manager.fork(params.id, str(body.promptUuid, 'promptUuid')),
  },
  {
    method: 'POST',
    path: '/api/agents/:id/rewind',
    summary: 'Drops that turn and everything after it; only when idle with nothing queued. Files are not touched',
    body: '`{ promptUuid }`',
    result: AGENT,
    handler: ({ manager, params, body }) => manager.rewind(params.id, str(body.promptUuid, 'promptUuid')),
  },
  {
    method: 'POST',
    path: '/api/agents/:id/messages',
    summary: "Queues a message from the user and sets the agent's open question sets aside (status `chat`)",
    body:
      "`{ text, images?, notify? }`. `images`: up to 10 of `{ mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data }` (base64, at most 5 MB each); `text` may be empty when there are images",
    result: 'The queued message',
    maxBody: MAX_MESSAGE_BODY,
    handler: ({ manager, params, body }) => {
      const images = imagesOf(body.images);
      const text = images.length ? (typeof body.text === 'string' ? body.text : '') : str(body.text, 'text');
      const sent = manager.sendMessage(params.id, text, 'user', body.notify === true, {}, images);
      manager.setAsideQuestions(params.id);
      return sent;
    },
  },
  {
    method: 'POST',
    path: '/api/agents/:id/interrupt',
    summary: 'Cancels the current turn; keeps the queue and the process',
    result: AGENT,
    handler: async ({ manager, params }) => {
      await manager.interrupt(params.id);
      return manager.get(params.id);
    },
  },
  {
    method: 'POST',
    path: '/api/agents/:id/stop',
    summary: 'Cancels the turn, clears the queue and closes the process',
    result: AGENT,
    handler: async ({ manager, params }) => {
      await manager.stop(params.id, 'user');
      return manager.get(params.id);
    },
  },
  {
    method: 'DELETE',
    path: '/api/agents/:id/queue/:messageId',
    summary: 'Removes a queued message',
    result: AGENT,
    handler: ({ manager, params }) => {
      manager.removeQueued(params.id, params.messageId);
      return manager.get(params.id);
    },
  },
  {
    method: 'POST',
    path: '/api/agents/:id/model',
    summary: 'Sets the model and effort; a missing field stays, `null` goes back to the default. Applies from the next turn',
    body: '`{ model?: string | null, effort?: EffortLevel | null }`',
    result: AGENT,
    handler: ({ manager, params, body }) => {
      const change: { model?: string | null; effort?: EffortLevel | null } = {};
      if ('model' in body) {
        if (body.model !== null && typeof body.model !== 'string') throw new HttpError(400, '"model" must be a string or null');
        change.model = body.model;
      }
      if ('effort' in body) {
        if (body.effort !== null && !EFFORT_LEVELS.includes(body.effort)) {
          throw new HttpError(400, `"effort" must be one of ${EFFORT_LEVELS.join(', ')} or null`);
        }
        change.effort = body.effort;
      }
      return manager.setModel(params.id, change);
    },
  },
  {
    method: 'POST',
    path: '/api/agents/:id/keep-warm',
    summary:
      'Keeps the prompt cache warm for `minutes` after each turn (0 = not by time; capped at 45 for a 5 minute cache and 480 for a 1 hour cache), and for chats while their experts work. Both off turns it off',
    body: '`{ minutes: number, experts?: boolean }`',
    result: 'The agent record (`keepWarm` holds the settings, `warm` what it is doing)',
    handler: ({ manager, params, body }) => {
      if (typeof body.minutes !== 'number') throw new HttpError(400, '"minutes" must be a number');
      if (body.experts !== undefined && typeof body.experts !== 'boolean') throw new HttpError(400, '"experts" must be true or false');
      return manager.setKeepWarm(params.id, { minutes: body.minutes, experts: body.experts === true });
    },
  },
  {
    method: 'POST',
    path: '/api/agents/:id/notifications',
    summary: 'Chats only: holds expert notifications in the queue, or lets them through again as one combined message',
    body: '`{ paused: boolean }`',
    result: AGENT,
    handler: ({ manager, params, body }) => {
      if (typeof body.paused !== 'boolean') throw new HttpError(400, '"paused" must be true or false');
      return manager.setNotificationsPaused(params.id, body.paused);
    },
  },
  {
    method: 'POST',
    path: '/api/agents/:id/permission',
    summary:
      "Answers a waiting permission request. `allowSession` adds the SDK's suggested rules to this session only; `message` goes to the agent with a denial",
    body: "`{ requestId, decision: 'allow' | 'allowSession' | 'deny', message? }`",
    result: 'The permission request',
    handler: ({ manager, params, body }) => {
      const decisions: PermissionDecision[] = ['allow', 'allowSession', 'deny'];
      if (!decisions.includes(body.decision)) throw new HttpError(400, `"decision" must be one of ${decisions.join(', ')}`);
      if (body.message !== undefined && typeof body.message !== 'string') throw new HttpError(400, '"message" must be a string');
      return manager.answerPermission(params.id, str(body.requestId, 'requestId'), body.decision, body.message);
    },
  },
  {
    method: 'POST',
    path: '/api/agents/:id/archive',
    summary:
      'Archives or unarchives an agent; refused while running. A chat takes its idle experts with it, and unarchiving brings those back. Archiving closes the process; a new message unarchives',
    body: '`{ archived: boolean }`',
    result: AGENT,
    handler: ({ manager, params, body }) => {
      if (typeof body.archived !== 'boolean') throw new HttpError(400, '"archived" must be true or false');
      return manager.setArchived(params.id, body.archived);
    },
  },
];

/** The server-sent events on `GET /api/events`, each with what its `data` holds. */
export const SSE_EVENTS: { name: string; data: string }[] = [
  { name: 'snapshot', data: 'Every agent record (AgentRecord[]); sent first on each connection' },
  { name: 'agent', data: 'One agent record that changed' },
  { name: 'delivered', data: '`{ agentId, message, images? }`: a queued message was delivered (images only once, for open transcripts)' },
  {
    name: 'message',
    data: '`{ agentId, message }`: an SDK message (assistant, user, result, and system init, permission_denied, compact_boundary, api_retry, task_started, task_progress, task_notification)',
  },
  { name: 'plan', data: 'A track plan that was created or changed (all plans follow each snapshot)' },
  { name: 'questions', data: 'A question set that was created or changed (all sets follow each snapshot)' },
  { name: 'permission', data: 'A permission request that was opened or answered (all requests follow each snapshot)' },
];

/** The API's docs: every route without its handler. */
export function describeRoutes(): RouteDoc[] {
  return routes.map(({ method, path, summary, query, body, result }) => ({
    method,
    path,
    summary,
    ...(query ? { query } : {}),
    ...(body ? { body } : {}),
    result,
  }));
}

const segments = (p: string) => p.split('/').filter(Boolean);
const compiled = routes.map((route) => ({ route, pattern: segments(route.path) }));

/** The route for a method and path, with its params. A path no route has, or has with another method, is a 404. */
function match(method: string, pathname: string): { route: Route; params: Record<string, string> } | undefined {
  const parts = segments(pathname);
  for (const { route, pattern } of compiled) {
    if (route.method !== method || pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const ok = pattern.every((p, i) => {
      if (!p.startsWith(':')) return p === parts[i];
      params[p.slice(1)] = parts[i];
      return true;
    });
    if (ok) return { route, params };
  }
  return undefined;
}

async function dispatch(req: http.IncomingMessage, url: URL, base: Pick<RouteContext, 'manager' | 'config' | 'openStream'>): Promise<unknown> {
  const found = match(req.method ?? 'GET', url.pathname);
  if (!found) throw new HttpError(404, 'Not found');
  // Only routes that take a body read one, as before: a stray body on the others is ignored.
  const body = found.route.body ? await readJson(req, found.route.maxBody) : {};
  return found.route.handler({ ...base, params: found.params, url, body });
}

/** The folders an agent's Files panel may show: its own, then the ones it was given access to. */
function rootsOf(manager: Manager, id: string): { name: string; path: string }[] {
  const rec = manager.get(id);
  const roots = [rec.cwd];
  const parent = rec.parentId ? manager.get(rec.parentId) : undefined;
  if (parent && path.resolve(parent.cwd) !== path.resolve(rec.cwd)) roots.push(parent.cwd);
  return roots.map((p) => ({ name: path.basename(p) || p, path: p }));
}

/** The root folder (`?root=`, an index into the agent's roots) and the relative `?path=` of a file route. */
function fileRoot({ manager, params, url }: RouteContext): { root: string; rel: string } {
  const roots = rootsOf(manager, params.id);
  const index = Number(url.searchParams.get('root') ?? '0');
  const root = Number.isInteger(index) ? roots[index] : undefined;
  if (!root) throw new HttpError(400, `"root" must be the index of one of the agent's folders`);
  return { root: root.path, rel: url.searchParams.get('path') ?? '' };
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const NOT_BUILT = `<!doctype html><meta charset="utf-8"><title>Centurion</title>
<body style="font:15px system-ui;padding:40px">
<h1 style="font-size:18px">The UI is not built yet</h1>
<p>Run <code>npm run build</code> and reload this page, or use <code>npm run dev</code> while working on the UI.</p>`;

/** Serve the built UI from dist/ui. Unknown paths get index.html (single-page app). */
async function serveUi(dir: string, pathname: string, res: http.ServerResponse): Promise<void> {
  const root = path.resolve(dir);
  const wanted = path.resolve(root, `.${decodeURIComponent(pathname)}`);
  const inside = wanted === root || wanted.startsWith(root + path.sep);
  const candidates = inside && pathname !== '/' ? [wanted, path.join(root, 'index.html')] : [path.join(root, 'index.html')];
  for (const file of candidates) {
    try {
      const body = await readFile(file);
      const type = CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream';
      const cache = file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
      res.writeHead(200, { 'content-type': type, 'cache-control': cache }).end(body);
      return;
    } catch {
      // try the next candidate
    }
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(NOT_BUILT);
}

function str(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `"${field}" is required`);
  return value;
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) throw new HttpError(400, `"${field}" must be a list of strings`);
  return value;
}

function list(value: unknown, field: string): Record<string, any>[] {
  if (!Array.isArray(value) || !value.every((v) => v && typeof v === 'object')) throw new HttpError(400, `"${field}" must be a list`);
  return value;
}

function imagesOf(value: unknown): ImageData[] {
  if (value === undefined) return [];
  const images = list(value, 'images');
  if (images.length > MAX_IMAGES) throw new HttpError(400, `At most ${MAX_IMAGES} images per message`);
  return images.map((image) => {
    if (!IMAGE_TYPES.includes(image.mediaType)) throw new HttpError(400, `Images must be one of ${IMAGE_TYPES.join(', ')}`);
    if (typeof image.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new HttpError(400, 'Image data must be base64');
    if (image.data.length > MAX_IMAGE_BYTES) throw new HttpError(400, 'An image is larger than the API allows (5 MB, base64 encoded)');
    return { mediaType: image.mediaType, data: image.data };
  });
}

async function readJson(req: http.IncomingMessage, max = MAX_BODY): Promise<Record<string, any>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, 'Body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body is not valid JSON');
  }
}
