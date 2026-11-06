import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from './config.js';
import type { Manager } from './manager.js';
import { EFFORT_LEVELS, type EffortLevel, type PermissionDecision } from './types.js';

const MAX_BODY = 1024 * 1024;

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
    return ['init', 'permission_denied', 'compact_boundary', 'api_retry'].includes(message.subtype as string);
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

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(404, 'Not found');
        await serveUi(config.uiDir, url.pathname, res);
        return;
      }
      if (!authorized(req, url)) throw new HttpError(401, 'Missing or wrong token');

      if (req.method === 'GET' && url.pathname === '/api/events') {
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
        return;
      }

      const result = await route(manager, config, req, url);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 400;
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
  });

  server.listen(config.port, config.host, () => {
    const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
    const token = config.token ? `?token=${encodeURIComponent(config.token)}` : '';
    console.log(`Agent manager listening on http://${shown}:${config.port}/${token}`);
    console.log(`Permission mode: ${config.permissionMode}. State: ${config.stateFile}`);
    console.log(`Orchestrators run in: ${config.orchestratorFolder}`);
  });
  return server;
}

async function route(manager: Manager, config: Config, req: http.IncomingMessage, url: URL): Promise<unknown> {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
  const method = req.method ?? 'GET';

  if (parts[0] === 'info' && method === 'GET') {
    return {
      permissionMode: config.permissionMode,
      orchestratorFolder: config.orchestratorFolder,
      platform: process.platform,
      defaultModel: config.model,
    };
  }
  if (parts[0] === 'models' && method === 'GET') return manager.models();
  if (parts[0] === 'plans' && parts.length === 1 && method === 'GET') return manager.listPlans();
  if (parts[0] === 'plans' && parts[2] === 'start' && method === 'POST') {
    const body = await readJson(req);
    return manager.startPlan(parts[1], strings(body.start, 'start'), strings(body.skip ?? [], 'skip'));
  }
  if (parts[0] === 'plans' && parts[2] === 'notify' && method === 'POST') {
    const body = await readJson(req);
    if (body.mode !== 'round' && body.mode !== 'each') throw new HttpError(400, '"mode" must be "round" or "each"');
    return manager.setPlanNotify(parts[1], body.mode);
  }
  if (parts[0] === 'questions' && parts.length === 1 && method === 'GET') return manager.listQuestionSets();
  if (parts[0] === 'questions' && parts[2] === 'answer' && method === 'POST') {
    const body = await readJson(req);
    const answers = list(body.answers, 'answers').map((a) => ({
      questionId: str(a.questionId, 'questionId'),
      choices: a.choices === undefined ? [] : strings(a.choices, 'choices'),
      text: typeof a.text === 'string' ? a.text : '',
    }));
    const corrections = list(body.corrections ?? [], 'corrections').map((c) => ({
      questionId: str(c.questionId, 'questionId'),
      text: str(c.text, 'text'),
    }));
    return manager.answerQuestions(parts[1], answers, corrections);
  }
  if (parts[0] !== 'agents') throw new HttpError(404, 'Not found');

  if (parts.length === 1 && method === 'GET') return manager.list();
  if (parts.length === 1 && method === 'POST') {
    const body = await readJson(req);
    const message = typeof body.message === 'string' && body.message.trim() ? body.message : undefined;
    return manager.createOrchestrator({ name: str(body.name, 'name'), message });
  }

  const id = parts[1];
  if (parts.length === 2 && method === 'GET') return manager.get(id);
  if (parts[2] === 'history' && method === 'GET') return manager.history(id);
  if (parts[2] === 'messages' && method === 'POST') {
    const body = await readJson(req);
    return manager.sendMessage(id, str(body.text, 'text'), 'user', body.notify === true);
  }
  if (parts[2] === 'experts' && method === 'POST') {
    const body = await readJson(req);
    const message = typeof body.message === 'string' && body.message.trim() ? body.message : undefined;
    const cwd = typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : undefined;
    return manager.createExpert(id, { name: str(body.name, 'name'), cwd, message }, 'user');
  }
  if (parts[2] === 'stop' && method === 'POST') {
    await manager.stop(id, 'user');
    return manager.get(id);
  }
  if (parts[2] === 'interrupt' && method === 'POST') {
    await manager.interrupt(id);
    return manager.get(id);
  }
  if (parts[2] === 'queue' && parts.length === 4 && method === 'DELETE') {
    manager.removeQueued(id, parts[3]);
    return manager.get(id);
  }
  if (parts[2] === 'model' && method === 'POST') {
    const body = await readJson(req);
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
    return manager.setModel(id, change);
  }
  if (parts[2] === 'permission' && method === 'POST') {
    const body = await readJson(req);
    const decisions: PermissionDecision[] = ['allow', 'allowSession', 'deny'];
    if (!decisions.includes(body.decision)) throw new HttpError(400, `"decision" must be one of ${decisions.join(', ')}`);
    if (body.message !== undefined && typeof body.message !== 'string') throw new HttpError(400, '"message" must be a string');
    return manager.answerPermission(id, str(body.requestId, 'requestId'), body.decision, body.message);
  }
  if (parts[2] === 'archive' && method === 'POST') {
    const body = await readJson(req);
    if (typeof body.archived !== 'boolean') throw new HttpError(400, '"archived" must be true or false');
    return manager.setArchived(id, body.archived);
  }
  throw new HttpError(404, 'Not found');
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

const NOT_BUILT = `<!doctype html><meta charset="utf-8"><title>Agent manager</title>
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

async function readJson(req: http.IncomingMessage): Promise<Record<string, any>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body is not valid JSON');
  }
}
