import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';

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
      "Required on every API call (`Authorization: Bearer` or `?token=`). Empty disables the check, so don't do that with `bypassPermissions`.",
    ),
  stateFile: z
    .string()
    .default('.centurion/state.json')
    .describe('JSON state file, relative to the config file. Keep one per environment: session IDs only exist on the machine that created them.'),
  orchestratorFolder: z
    .string()
    .nullable()
    .default(null)
    .describe(
      'Folder every top-level chat runs in, relative to the config file or absolute. `null` or missing: the folder the manager was started from. Checked at startup.',
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
  idleMinutes: z
    .number()
    .min(0)
    .default(10)
    .describe("Close an agent's process after this many idle minutes (`0` = never). The next message resumes the session."),
});

type FileConfig = z.output<typeof configSchema>;

export type Config = Omit<FileConfig, 'orchestratorFolder'> & {
  /** Absolute folder every orchestrator runs in. */
  orchestratorFolder: string;
  /** Folder holding the orchestrator/expert instruction files. */
  promptsDir: string;
  /** Folder holding the built UI (`npm run build`). */
  uiDir: string;
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

const projectRoot = path.resolve(import.meta.dirname, '..');

/**
 * Loads config from (in order): --config <path>, CENTURION_CONFIG, or
 * centurion.config.json in the project root. Missing file means defaults.
 * Relative paths in the file resolve against the file's own folder.
 */
export function loadConfig(argv = process.argv.slice(2)): Config {
  const flag = argv.indexOf('--config');
  const file = path.resolve(
    flag >= 0 && argv[flag + 1]
      ? argv[flag + 1]
      : process.env.CENTURION_CONFIG ?? path.join(projectRoot, 'centurion.config.json'),
  );
  const exists = existsSync(file);
  const merged = parseFile(file, exists ? readFileSync(file, 'utf8') : '{}');
  const base = exists ? path.dirname(file) : projectRoot;

  if (process.env.CENTURION_PORT) merged.port = Number(process.env.CENTURION_PORT);
  if (process.env.CENTURION_HOST) merged.host = process.env.CENTURION_HOST;
  if (process.env.CENTURION_TOKEN !== undefined) merged.token = process.env.CENTURION_TOKEN;

  const orchestratorFolder = path.resolve(base, merged.orchestratorFolder ?? process.cwd());
  if (!existsSync(orchestratorFolder) || !statSync(orchestratorFolder).isDirectory()) {
    throw new ConfigError(`orchestratorFolder does not exist: ${orchestratorFolder}`);
  }

  return {
    ...merged,
    stateFile: path.resolve(base, merged.stateFile),
    orchestratorFolder,
    promptsDir: path.join(projectRoot, 'prompts'),
    uiDir: path.join(projectRoot, 'dist', 'ui'),
  };
}

function parseFile(file: string, text: string): FileConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`Config file ${file} is not valid JSON: ${(err as Error).message}`);
  }
  const result = configSchema.safeParse(raw);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => {
    if (issue.code === 'unrecognized_keys') return issue.keys.map((k) => `unknown field "${k}"`).join(', ');
    return issue.path.length ? `"${issue.path.join('.')}": ${issue.message}` : issue.message;
  });
  throw new ConfigError(`Config file ${file} is invalid:\n  - ${problems.join('\n  - ')}`);
}
