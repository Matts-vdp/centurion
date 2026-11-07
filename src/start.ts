import { HOME_DIR } from './paths.js';
import type { Config } from './config.js';
import { Manager } from './manager.js';
import { startServer } from './server.js';
import { dim, yellow } from './term.js';

/**
 * Node warnings the manager drops. CLAUDE_SDK_CAN_USE_TOOL_SHADOWED comes with every query() whose allowedTools
 * name a whole MCP server: the in-process `display` and `centurion` servers are allowed on purpose, so their calls
 * skip canUseTool (see buildOptions in manager.ts).
 */
const QUIET_WARNINGS = new Set(['CLAUDE_SDK_CAN_USE_TOOL_SHADOWED']);

export function filterWarnings(): void {
  const emit = process.emitWarning.bind(process) as (...args: unknown[]) => void;
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const [opts, code] = rest;
    const found =
      (warning instanceof Error && (warning as NodeJS.ErrnoException).code) ||
      (opts && typeof opts === 'object' && (opts as { code?: string }).code) ||
      (typeof code === 'string' && code);
    if (typeof found === 'string' && QUIET_WARNINGS.has(found)) return;
    emit(warning, ...rest);
  }) as typeof process.emitWarning;
}

/** `centurion start`: runs the manager and its HTTP server until SIGINT / SIGTERM. */
export function start(config: Config): void {
  filterWarnings();
  if (config.legacyConfig) {
    console.warn(yellow(`Note: using ${config.configFile}. Newer setups keep it as ${HOME_DIR}/config.json (\`centurion init\` creates one).`));
  }
  const manager = new Manager(config);
  const server = startServer(manager, config);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(dim('Shutting down: saving state and closing agents…'));
    manager.shutdown();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
