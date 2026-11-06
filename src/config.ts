import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';

export type Config = {
  /** Interface to bind. Keep 127.0.0.1 unless you use plain `docker -p` (then 0.0.0.0). */
  host: string;
  port: number;
  /** Shared secret every API call must carry. Empty string disables the check. */
  token: string;
  /** Absolute path of the JSON state file. */
  stateFile: string;
  /** Permission mode for every agent: 'auto' at home, 'bypassPermissions' in a dev container. */
  permissionMode: PermissionMode;
  /** Model override for all agents; null uses the Claude Code default. */
  model: string | null;
  /** Extra environment variables for agent processes (e.g. Foundry auth). */
  env: Record<string, string>;
  /** Environment variables to strip before starting agents. */
  removeEnv: string[];
  /** Close an agent's process after this many idle minutes (0 = never). The next message resumes it. */
  idleMinutes: number;
  /** Absolute folder every orchestrator runs in. Defaults to the folder the manager was started from. */
  orchestratorFolder: string;
  /** Folder holding the orchestrator/expert instruction files. */
  promptsDir: string;
  /** Folder holding the built UI (`npm run build`). */
  uiDir: string;
};

const projectRoot = path.resolve(import.meta.dirname, '..');

const defaults = {
  host: '127.0.0.1',
  port: 4317,
  token: '',
  stateFile: '.agent-manager/state.json',
  permissionMode: 'auto' as PermissionMode,
  model: null,
  env: {},
  removeEnv: [],
  idleMinutes: 10,
};

/**
 * Loads config from (in order): --config <path>, AGENT_MANAGER_CONFIG, or
 * agent-manager.config.json in the project root. Missing file means defaults.
 * Relative paths in the file resolve against the file's own folder.
 */
export function loadConfig(argv = process.argv.slice(2)): Config {
  const flag = argv.indexOf('--config');
  const file = path.resolve(
    flag >= 0 && argv[flag + 1]
      ? argv[flag + 1]
      : process.env.AGENT_MANAGER_CONFIG ?? path.join(projectRoot, 'agent-manager.config.json'),
  );
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const merged = { ...defaults, ...raw };
  const base = existsSync(file) ? path.dirname(file) : projectRoot;

  if (process.env.AGENT_MANAGER_PORT) merged.port = Number(process.env.AGENT_MANAGER_PORT);
  if (process.env.AGENT_MANAGER_HOST) merged.host = process.env.AGENT_MANAGER_HOST;
  if (process.env.AGENT_MANAGER_TOKEN !== undefined) merged.token = process.env.AGENT_MANAGER_TOKEN;

  const orchestratorFolder = path.resolve(base, merged.orchestratorFolder ?? process.cwd());
  if (!existsSync(orchestratorFolder) || !statSync(orchestratorFolder).isDirectory()) {
    throw new Error(`orchestratorFolder does not exist: ${orchestratorFolder}`);
  }

  return {
    ...merged,
    stateFile: path.resolve(base, merged.stateFile),
    orchestratorFolder,
    promptsDir: path.join(projectRoot, 'prompts'),
    uiDir: path.join(projectRoot, 'dist', 'ui'),
  };
}
