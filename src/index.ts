import { ConfigError, loadConfig, type Config } from './config.js';
import { Manager } from './manager.js';
import { startServer } from './server.js';

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(err.message);
  process.exit(1);
}
const manager = new Manager(config);
const server = startServer(manager, config);

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Shutting down: saving state and closing agents…');
  manager.shutdown();
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
