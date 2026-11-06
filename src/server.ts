import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from './config.js';
import type { Manager } from './manager.js';

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
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = await readFile(path.join(config.publicDir, 'index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
        return;
      }
      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');
      if (!authorized(req, url)) throw new HttpError(401, 'Missing or wrong token');

      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(`event: snapshot\ndata: ${JSON.stringify(manager.list())}\n\n`);
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
  });
  return server;
}

async function route(manager: Manager, config: Config, req: http.IncomingMessage, url: URL): Promise<unknown> {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
  const method = req.method ?? 'GET';

  if (parts[0] === 'info' && method === 'GET') {
    return { permissionMode: config.permissionMode, cwd: process.cwd(), platform: process.platform };
  }
  if (parts[0] !== 'agents') throw new HttpError(404, 'Not found');

  if (parts.length === 1 && method === 'GET') return manager.list();
  if (parts.length === 1 && method === 'POST') {
    const body = await readJson(req);
    return manager.createOrchestrator({ name: str(body.name, 'name'), cwd: str(body.cwd, 'cwd'), message: body.message });
  }

  const id = parts[1];
  if (parts.length === 2 && method === 'GET') return manager.get(id);
  if (parts[2] === 'history' && method === 'GET') return manager.history(id);
  if (parts[2] === 'messages' && method === 'POST') {
    const body = await readJson(req);
    return manager.sendMessage(id, str(body.text, 'text'), 'user', body.notify === true);
  }
  if (parts[2] === 'stop' && method === 'POST') {
    await manager.stop(id, 'user');
    return manager.get(id);
  }
  throw new HttpError(404, 'Not found');
}

function str(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `"${field}" is required`);
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
