import { HOME_DIR } from './paths.js';
import type { Config } from './config.js';
import { Manager } from './manager.js';
import { startServer } from './server.js';

/** `centurion start`: runs the manager and its HTTP server until SIGINT / SIGTERM. */
export function start(config: Config): void {
  if (config.legacyConfig) {
    console.warn(`Note: using ${config.configFile}. Newer setups keep it as ${HOME_DIR}/config.json (\`centurion init\` creates one).`);
  }
  const manager = new Manager(config);
  const server = startServer(manager, config);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Shutting down: saving state and closing agents…');
    manager.shutdown();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
