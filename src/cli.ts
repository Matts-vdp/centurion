#!/usr/bin/env node
// The `centurion` command. See `usage()` in docs.ts for the commands.
import { ConfigError, loadConfig } from './config.js';
import { agentGuide, apiJson, apiMarkdown, configJson, configMarkdown, toolsMarkdown, describeTools, usage } from './docs.js';
import { init } from './init.js';
import { packageVersion } from './paths.js';
import { start } from './start.js';
import { StateError } from './state.js';

const FLAGS: Record<string, string[]> = {
  start: [],
  init: ['--container'],
  config: ['--json'],
  api: ['--json'],
  tools: ['--json'],
  help: ['--agent'],
};

class UsageError extends Error {}

function parse(argv: string[]): { command: string; flags: Set<string> } {
  const positional: string[] = [];
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config') i++; // its value is read by loadConfig
    else if (arg.startsWith('-')) flags.add(arg);
    else positional.push(arg);
  }
  if (flags.has('--version') || flags.has('-v')) return { command: 'version', flags };
  if (flags.has('--help') || flags.has('-h')) return { command: 'help', flags };
  const command = positional[0] ?? 'start';
  if (!(command in FLAGS)) throw new UsageError(`Unknown command: ${command}`);
  if (positional.length > 1) throw new UsageError(`Unexpected argument: ${positional[1]}`);
  for (const flag of flags) if (!FLAGS[command].includes(flag)) throw new UsageError(`Unknown option for ${command}: ${flag}`);
  return { command, flags };
}

const print = (text: string): void => {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
};
const json = (data: unknown): void => print(JSON.stringify(data, null, 2));

function run(argv: string[]): void {
  const { command, flags } = parse(argv);
  switch (command) {
    case 'version':
      return print(packageVersion);
    case 'help':
      return print(flags.has('--agent') ? agentGuide() : usage());
    case 'init':
      return print(init(process.cwd(), { container: flags.has('--container') }).join('\n'));
    case 'api':
      return flags.has('--json') ? json(apiJson()) : print(apiMarkdown());
    case 'tools':
      return flags.has('--json') ? json(describeTools()) : print(toolsMarkdown());
    case 'config': {
      const config = loadConfig({ argv });
      return flags.has('--json') ? json(configJson(config)) : print(configMarkdown(config));
    }
    case 'start':
      return start(loadConfig({ argv, ensureToken: true }));
  }
}

try {
  run(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`${err.message}\n\n${usage()}`);
    process.exit(2);
  }
  if (err instanceof ConfigError || err instanceof StateError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
