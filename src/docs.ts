// Centurion's self-description: the text behind `centurion help`, `api`, `tools`, `config` and `GET /api/docs`.
// Everything is generated from the code (routes, config schema, tool definitions), so it can't drift.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { describeConfig, type Config } from './config.js';
import { displayTools } from './display.js';
import { PROMPT_PLACEHOLDERS, promptFile, type Manager } from './manager.js';
import { guideFile, HOME_DIR, packagedPromptsDir, packageVersion } from './paths.js';
import { describeRoutes, SSE_EVENTS } from './server.js';
import { managerTools } from './tools.js';

/** The CLI's commands and options, for `centurion help` and the agent guide. */
export const COMMANDS: { name: string; summary: string; options?: [string, string][] }[] = [
  { name: 'start', summary: 'Start the manager for this managing folder (the default command). Prints the URL with the token.' },
  {
    name: 'init',
    summary: `Create \`${HOME_DIR}/\` in the current folder: \`config.json\`, \`prompts/\` (the packaged prompts, ready to edit) and a \`.gitignore\` for \`state/\`. Never overwrites a file.`,
    options: [['--container', 'Write `permissionMode: "bypassPermissions"`. Only for a repo that runs in a dev container.']],
  },
  { name: 'config', summary: 'Show the resolved config, where each value came from, and the files in use.', options: [['--json', 'As JSON.']] },
  { name: 'api', summary: 'The HTTP API: every endpoint, the server-sent events, auth and deep links.', options: [['--json', 'As JSON.']] },
  { name: 'tools', summary: 'The tools agents get (`centurion` for chats, `display` for every agent) with their arguments.', options: [['--json', 'As JSON.']] },
  {
    name: 'help',
    summary: 'Usage.',
    options: [['--agent', 'A full guide for an agent that sets up, changes or integrates Centurion.']],
  },
];

export const GLOBAL_OPTIONS: [string, string][] = [
  ['--config <file>', `Use this config file instead of \`${HOME_DIR}/config.json\` (also \`CENTURION_CONFIG\`).`],
  ['--version, -v', 'Print the version.'],
  ['--help, -h', 'Print the usage.'],
];

const plain = (s: string) => s.replaceAll('`', '');

/** `centurion help`. */
export function usage(): string {
  const lines = [`Centurion ${packageVersion}: a local manager for Claude agents across repositories.`, '', 'Usage: centurion [command] [options]', '', 'Commands:'];
  for (const c of COMMANDS) {
    lines.push(`  ${c.name.padEnd(16)} ${plain(c.summary)}`);
    for (const [flag, text] of c.options ?? []) lines.push(`    ${flag.padEnd(14)} ${plain(text)}`);
  }
  lines.push('', 'Options:');
  for (const [flag, text] of GLOBAL_OPTIONS) lines.push(`  ${flag.padEnd(16)} ${plain(text)}`);
  lines.push('', 'CENTURION_PORT, CENTURION_HOST and CENTURION_TOKEN override the config file.');
  return lines.join('\n');
}

// ---------- API ----------

const AUTH =
  'Every `/api/` call needs the token: `Authorization: Bearer <token>` or `?token=<token>` (an `EventSource` can only use the query form). ' +
  'Bodies and results are JSON; an error is `{ error }` with a 4xx status.';
const DEEP_LINK = '`/?token=<token>#agent=<id>` opens the UI on one agent (the browser tab keeps the token, so in that tab `#agent=<id>` alone switches agents; a new tab needs `?token=` again).';

export function apiJson() {
  return { version: packageVersion, auth: AUTH, deepLink: DEEP_LINK, routes: describeRoutes(), events: SSE_EVENTS };
}

export function apiMarkdown(): string {
  const out = [`# Centurion HTTP API (${packageVersion})`, '', AUTH, '', `UI: \`/\` serves the web UI. ${DEEP_LINK}`, '', '## Endpoints'];
  for (const r of describeRoutes()) {
    out.push('', `### \`${r.method} ${r.path}\``, '', r.summary);
    if (r.query) out.push(`- Query: ${r.query}`);
    if (r.body) out.push(`- Body: ${r.body}`);
    out.push(`- Result: ${r.result}`);
  }
  out.push('', '## Events (`GET /api/events`)', '', 'Each event is `event: <name>` with JSON `data`.', '');
  for (const e of SSE_EVENTS) out.push(`- \`${e.name}\`: ${e.data}`);
  return out.join('\n');
}

// ---------- tools ----------

type JsonSchema = { type?: string | string[]; description?: string; properties?: Record<string, JsonSchema>; required?: string[]; items?: JsonSchema; enum?: unknown[]; anyOf?: JsonSchema[] };

export type ToolDoc = { server: string; givenTo: string; name: string; fullName: string; description: string; input: JsonSchema };

/** Every tool Centurion gives agents. Definitions are built with a stand-in manager; no handler runs. */
export function describeTools(): ToolDoc[] {
  const stub = {} as Manager;
  const servers = [
    { server: 'centurion', givenTo: 'every top-level chat', tools: managerTools(stub, '') },
    { server: 'display', givenTo: 'every agent', tools: displayTools(stub, '') },
  ];
  return servers.flatMap(({ server, givenTo, tools }) =>
    tools.map((t) => ({
      server,
      givenTo,
      name: t.name,
      fullName: `mcp__${server}__${t.name}`,
      description: t.description,
      input: z.toJSONSchema(z.object(t.inputSchema as z.ZodRawShape), { io: 'input' }) as JsonSchema,
    })),
  );
}

function schemaType(s: JsonSchema): string {
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (s.anyOf) return s.anyOf.map(schemaType).join(' | ');
  const t = Array.isArray(s.type) ? s.type.join(' | ') : (s.type ?? 'any');
  return t === 'array' && s.items ? `${schemaType(s.items)}[]` : t;
}

export function toolsMarkdown(): string {
  const tools = describeTools();
  const out = [`# Centurion's agent tools (${packageVersion})`];
  for (const server of [...new Set(tools.map((t) => t.server))]) {
    const group = tools.filter((t) => t.server === server);
    out.push('', `## \`${server}\` (given to ${group[0].givenTo})`);
    for (const t of group) {
      out.push('', `### \`${t.fullName}\``, '', t.description);
      const props = Object.entries(t.input.properties ?? {});
      if (!props.length) {
        out.push('', 'No arguments.');
        continue;
      }
      out.push('', 'Arguments:');
      for (const [name, p] of props) {
        const required = t.input.required?.includes(name) ? 'required' : 'optional';
        out.push(`- \`${name}\` (${schemaType(p)}, ${required})${p.description ? `: ${p.description}` : ''}`);
      }
    }
  }
  return out.join('\n');
}

// ---------- config ----------

const cell = (s: string) => s.replaceAll('|', '\\|').replaceAll('\n', ' ');

export function configFieldsMarkdown(): string {
  const rows = describeConfig().map((f) => `| \`${f.name}\` | ${cell(f.type)} | \`${cell(JSON.stringify(f.default))}\` | ${cell(f.description)} |`);
  return ['| Field | Type | Default | Description |', '|---|---|---|---|', ...rows].join('\n');
}

/** The files a loaded config uses. */
function filesInUse(config: Config) {
  return {
    configFile: config.configFile,
    stateFile: config.stateFile,
    tokenFile: config.sources.token === 'generated' ? config.tokenFile : null,
    orchestratorFolder: config.orchestratorFolder,
    prompts: { expert: promptFile(config, 'expert', config.orchestratorFolder), orchestrator: promptFile(config, 'orchestrator', config.orchestratorFolder) },
    uiDir: config.uiDir,
  };
}

const shownValue = (config: Config, key: string): unknown => {
  if (key !== 'token') return (config as Record<string, unknown>)[key];
  if (!config.token) return config.sources.token === 'env' ? '(empty: the token check is off)' : '(none yet: generated on first start)';
  return '(hidden)';
};

export function configJson(config: Config) {
  return {
    version: packageVersion,
    files: filesInUse(config),
    values: Object.fromEntries(describeConfig().map((f) => [f.name, { value: shownValue(config, f.name), source: config.sources[f.name] }])),
    fields: describeConfig(),
  };
}

export function configMarkdown(config: Config): string {
  const files = filesInUse(config);
  const out = [
    `# Centurion config (${packageVersion})`,
    '',
    `- Config file: \`${files.configFile}\``,
    `- State file: \`${files.stateFile}\``,
    ...(files.tokenFile ? [`- Token file: \`${files.tokenFile}\``] : []),
    `- Default chat folder: \`${files.orchestratorFolder}\``,
    `- Expert prompt: ${files.prompts.expert ? `\`${files.prompts.expert}\`` : 'none'}`,
    `- Chat prompt: ${files.prompts.orchestrator ? `\`${files.prompts.orchestrator}\`` : 'none (chats get no appended prompt)'}`,
    "- Chats in other folders, and their experts, use that folder's `.centurion/prompts/<kind>.md`, else the packaged prompt.",
    '',
    '## Values',
    '',
    '| Field | Value | From |',
    '|---|---|---|',
    ...describeConfig().map((f) => `| \`${f.name}\` | \`${cell(JSON.stringify(shownValue(config, f.name)))}\` | ${config.sources[f.name]} |`),
    '',
    '## Fields',
    '',
    configFieldsMarkdown(),
  ];
  return out.join('\n');
}

// ---------- the agent guide ----------

/** `centurion help --agent`: the packaged guide with its generated parts filled in. */
export function agentGuide(): string {
  const template = existsSync(guideFile) ? readFileSync(guideFile, 'utf8') : '# Centurion\n\n{{commands}}\n';
  const commands = [
    ...COMMANDS.flatMap((c) => [`- \`centurion ${c.name}\`: ${c.summary}`, ...(c.options ?? []).map(([f, t]) => `  - \`${f}\`: ${t}`)]),
    ...GLOBAL_OPTIONS.map(([f, t]) => `- \`${f}\`: ${t}`),
  ].join('\n');
  const placeholders = Object.entries(PROMPT_PLACEHOLDERS)
    .map(([k, v]) => `- \`{{${k}}}\`: ${v}`)
    .join('\n');
  const tools = describeTools()
    .map((t) => `- \`${t.fullName}\` (${t.givenTo}): ${firstSentence(t.description)}`)
    .join('\n');
  const values: Record<string, string> = {
    version: packageVersion,
    home: HOME_DIR,
    commands,
    config: configFieldsMarkdown(),
    placeholders,
    tools,
    prompts: listPackagedPrompts(),
  };
  // One pass, so a placeholder name inside generated text (the placeholder list itself) is left alone.
  return template.replace(/\{\{(\w+)\}\}/g, (all, key: string) => values[key] ?? all);
}

function firstSentence(text: string): string {
  const m = /^(.+?[.!?])(\s|$)/s.exec(text.trim());
  return (m ? m[1] : text.trim()).replace(/\s+/g, ' ');
}

function listPackagedPrompts(): string {
  return ['expert', 'orchestrator']
    .map((kind) =>
      existsSync(path.join(packagedPromptsDir, `${kind}.md`))
        ? `- \`${kind}.md\`: has a packaged default (\`init\` copies it)`
        : `- \`${kind}.md\`: no packaged default; nothing is appended unless the repo adds one`,
    )
    .join('\n');
}
