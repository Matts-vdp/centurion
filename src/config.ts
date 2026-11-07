import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { HOME_DIR, packagedPromptsDir, uiDir } from './paths.js';

const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'] as const satisfies readonly PermissionMode[];

/** The config file's fields. Unknown fields and wrong types are refused at startup. */
export const configSchema = z.strictObject({
  host: z
    .string()
    .default('127.0.0.1')
    .describe('Interface the API and UI listen on. Keep 127.0.0.1 unless you use plain `docker -p` (then 0.0.0.0).'),
  port: z.number().int().min(0).max(65535).default(4317).describe('Port the API and UI listen on.'),
  token: z
    .string()
    .default('')
    .describe(
      'Token every API call must carry (`Authorization: Bearer` or `?token=`). Leave it empty in a committed config: then the token is ' +
        'generated into `token` next to the state file on first start. `CENTURION_TOKEN` overrides both; setting it to an empty string disables the check.',
    ),
  stateFile: z
    .string()
    .default('state/state.json')
    .describe(
      'JSON state file, relative to the config file. Uploads and the generated token live next to it. Keep one per environment: session IDs only exist on the machine that created them.',
    ),
  orchestratorFolder: z
    .string()
    .nullable()
    .default(null)
    .describe(
      'Folder every top-level chat runs in, relative to the config file or absolute. `null` or missing: the managing folder (the one holding `.centurion/`). Checked at startup.',
    ),
  permissionMode: z
    .enum(PERMISSION_MODES)
    .default('auto')
    .describe(
      "Permission mode for every agent: `auto` (the classifier decides; what it can't decide is asked in the UI) or `bypassPermissions` (dev containers).",
    ),
  model: z
    .string()
    .nullable()
    .default(null)
    .describe('Default model for agents that have none set, or `null` for the Claude Code default.'),
  env: z
    .record(z.string(), z.string())
    .default({})
    .describe('Extra environment variables for agent processes (e.g. Foundry auth).'),
  removeEnv: z.array(z.string()).default([]).describe('Environment variables to remove before starting agent processes.'),
  stripHostEnv: z
    .boolean()
    .default(true)
    .describe(
      "When Centurion runs inside a Claude Code session (`CLAUDECODE` is set), remove that session's variables (`CLAUDE*`, `ANTHROPIC_BASE_URL`, ...) " +
        'from agent processes, so they use their own settings. Auth and provider variables (`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_*`, `CLAUDE_CONFIG_DIR`) are kept; put anything else back with `env`.',
    ),
  idleMinutes: z
    .number()
    .min(0)
    .default(10)
    .describe("Close an agent's process after this many idle minutes (`0` = never). The next message resumes the session."),
});

type FileConfig = z.output<typeof configSchema>;

/** Where a config value came from. */
export type ConfigSource = 'default' | 'file' | 'env' | 'generated';

export type Config = Omit<FileConfig, 'orchestratorFolder'> & {
  /** Absolute folder every orchestrator runs in. */
  orchestratorFolder: string;
  /** The config file that was loaded. */
  configFile: string;
  /** The config file's folder (normally `<managing folder>/.centurion`); relative paths resolve against it. */
  configDir: string;
  /** The repo's prompt replacements (`<configDir>/prompts/<kind>.md`). */
  repoPromptsDir: string;
  /** The packaged default prompts. */
  promptsDir: string;
  /** Folder holding the built UI (`npm run build`). */
  uiDir: string;
  /** Where the generated token is kept (next to the state file). */
  tokenFile: string;
  /** Where each config field's value came from. */
  sources: Record<string, ConfigSource>;
  /** Loaded from a `centurion.config.json` in the managing folder (the layout before `.centurion/`). */
  legacyConfig: boolean;
};

/** A config file that can't be used; the message names the file and the field. */
export class ConfigError extends Error {}

export type ConfigFieldDoc = { name: string; type: string; default: unknown; description: string };

/** The config file's fields, for docs: name, type, default and description of each. */
export function describeConfig(): ConfigFieldDoc[] {
  const json = z.toJSONSchema(configSchema, { io: 'input' }) as { properties: Record<string, JsonType & { default?: unknown; description?: string }> };
  return Object.entries(json.properties).map(([name, prop]) => ({
    name,
    type: typeName(prop),
    default: prop.default,
    description: prop.description ?? '',
  }));
}

type JsonType = { type?: string | string[]; enum?: unknown[]; items?: JsonType; additionalProperties?: JsonType | boolean };

function typeName(prop: JsonType): string {
  if (prop.enum) return prop.enum.map((v) => JSON.stringify(v)).join(' | ');
  const types = Array.isArray(prop.type) ? prop.type : [prop.type ?? 'unknown'];
  return types
    .map((t) => {
      if (t === 'array' && prop.items) return `${typeName(prop.items)}[]`;
      if (t === 'object' && typeof prop.additionalProperties === 'object') return `Record<string, ${typeName(prop.additionalProperties)}>`;
      return t;
    })
    .join(' | ');
}

/** The config file to load and the managing folder it belongs to. */
export type ConfigLocation = { file: string; managingFolder: string; legacy: boolean };

/**
 * Finds the config: `--config <path>`, else `CENTURION_CONFIG`, else `.centurion/config.json` in the current
 * folder or the nearest parent that has one, else a `centurion.config.json` in the current folder (the old layout).
 */
export function findConfig(argv = process.argv.slice(2), cwd = process.cwd()): ConfigLocation {
  const flag = argv.indexOf('--config');
  const given = flag >= 0 ? argv[flag + 1] : process.env.CENTURION_CONFIG;
  if (flag >= 0 && !given) throw new ConfigError('--config needs a file path');
  if (given) {
    const file = path.resolve(cwd, given);
    if (!existsSync(file)) throw new ConfigError(`Config file not found: ${file}`);
    return { file, managingFolder: path.resolve(cwd), legacy: false };
  }
  for (let dir = path.resolve(cwd); ; ) {
    const file = path.join(dir, HOME_DIR, 'config.json');
    if (existsSync(file)) return { file, managingFolder: dir, legacy: false };
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const legacy = path.join(cwd, 'centurion.config.json');
  if (existsSync(legacy)) return { file: path.resolve(legacy), managingFolder: path.resolve(cwd), legacy: true };
  throw new ConfigError(
    `No ${HOME_DIR}/config.json in ${path.resolve(cwd)} or its parents.\n` +
      'Run `centurion init` in the managing folder (the one your chats should run in) to create one.',
  );
}

/**
 * Loads the config found by `findConfig`. Relative paths in the file resolve against the file's own folder.
 * `CENTURION_PORT`, `CENTURION_HOST` and `CENTURION_TOKEN` override the file. With `ensureToken`, a missing token
 * is generated into the token file; without it (for `centurion config`), nothing is written.
 */
export function loadConfig(options: { argv?: string[]; cwd?: string; ensureToken?: boolean } = {}): Config {
  const where = findConfig(options.argv, options.cwd);
  const raw = parseJson(where.file, readFileSync(where.file, 'utf8'));
  const merged = parseFile(where.file, raw);
  const configDir = path.dirname(where.file);

  const given = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const sources: Record<string, ConfigSource> = {};
  for (const key of Object.keys(configSchema.shape)) sources[key] = key in given ? 'file' : 'default';
  if (process.env.CENTURION_PORT) {
    merged.port = Number(process.env.CENTURION_PORT);
    sources.port = 'env';
  }
  if (process.env.CENTURION_HOST) {
    merged.host = process.env.CENTURION_HOST;
    sources.host = 'env';
  }

  const stateFile = path.resolve(configDir, merged.stateFile);
  const tokenFile = path.join(path.dirname(stateFile), 'token');
  if (process.env.CENTURION_TOKEN !== undefined) {
    merged.token = process.env.CENTURION_TOKEN;
    sources.token = 'env';
  } else if (!merged.token) {
    merged.token = readOrCreateToken(tokenFile, options.ensureToken ?? false);
    sources.token = 'generated';
  }

  const orchestratorFolder = merged.orchestratorFolder ? path.resolve(configDir, merged.orchestratorFolder) : where.managingFolder;
  if (!existsSync(orchestratorFolder) || !statSync(orchestratorFolder).isDirectory()) {
    throw new ConfigError(`orchestratorFolder does not exist: ${orchestratorFolder}`);
  }

  return {
    ...merged,
    stateFile,
    orchestratorFolder,
    configFile: where.file,
    configDir,
    repoPromptsDir: path.join(configDir, 'prompts'),
    promptsDir: packagedPromptsDir,
    uiDir,
    tokenFile,
    sources,
    legacyConfig: where.legacy,
  };
}

/** The generated token, or a new one written to `file` when `create` is set ('' when there is none yet). */
function readOrCreateToken(file: string, create: boolean): string {
  if (existsSync(file)) {
    const token = readFileSync(file, 'utf8').trim();
    if (token) return token;
  }
  if (!create) return '';
  const token = randomBytes(24).toString('base64url');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

function parseJson(file: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`Config file ${file} is not valid JSON: ${(err as Error).message}`);
  }
}

function parseFile(file: string, raw: unknown): FileConfig {
  const result = configSchema.safeParse(raw);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => {
    if (issue.code === 'unrecognized_keys') return issue.keys.map((k) => `unknown field "${k}"`).join(', ');
    return issue.path.length ? `"${issue.path.join('.')}": ${issue.message}` : issue.message;
  });
  throw new ConfigError(`Config file ${file} is invalid:\n  - ${problems.join('\n  - ')}`);
}
