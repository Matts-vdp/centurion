// `centurion init`: the basic files of a managing folder. It never overwrites; everything is tweaked by hand afterwards.
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HOME_DIR, packagedPromptsDir } from './paths.js';

/** Signs that this process runs in a container (Docker, a dev container, Codespaces). */
export function inContainer(): boolean {
  return existsSync('/.dockerenv') || existsSync('/run/.containerenv') || Boolean(process.env.REMOTE_CONTAINERS || process.env.CODESPACES || process.env.DEVCONTAINER);
}

/** Creates `.centurion/` in `cwd` and returns the lines to print. */
export function init(cwd: string, options: { container: boolean }): string[] {
  const home = path.join(cwd, HOME_DIR);
  const lines: string[] = [];
  const write = (rel: string, content: string) => {
    const file = path.join(home, rel);
    if (existsSync(file)) return lines.push(`  kept     ${HOME_DIR}/${rel} (exists)`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    lines.push(`  created  ${HOME_DIR}/${rel}`);
  };

  const config = {
    port: 4317,
    permissionMode: options.container ? 'bypassPermissions' : 'auto',
    model: null,
    idleMinutes: 10,
  };
  write('config.json', `${JSON.stringify(config, null, 2)}\n`);
  write('.gitignore', '# Per-environment state: the registry, queues, session IDs, uploads and the generated token\nstate/\n');
  for (const name of existsSync(packagedPromptsDir) ? readdirSync(packagedPromptsDir) : []) {
    const rel = `prompts/${name}`;
    const file = path.join(home, rel);
    if (existsSync(file)) {
      lines.push(`  kept     ${HOME_DIR}/${rel} (exists)`);
      continue;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    copyFileSync(path.join(packagedPromptsDir, name), file);
    lines.push(`  created  ${HOME_DIR}/${rel}`);
  }

  const notes: string[] = [];
  if (options.container && !inContainer()) notes.push('--container was given, but this does not look like a container: bypassPermissions lets agents do anything on this machine.');
  if (!options.container && inContainer()) notes.push('This looks like a container. If the repo only runs here, `"permissionMode": "bypassPermissions"` avoids permission prompts.');
  if (options.container && process.getuid?.() === 0) notes.push('Running as root: Claude Code refuses bypassPermissions as root. Use a non-root user (e.g. `remoteUser: node`).');

  return [
    `Centurion files in ${home}:`,
    ...lines,
    '',
    'Next:',
    `  - Commit ${HOME_DIR}/ (its state/ folder is ignored).`,
    `  - Edit ${HOME_DIR}/prompts/ to change what experts are told; a file there replaces the packaged prompt. Delete it to go back to the default.`,
    '  - Put your orchestration workflow in a skill, e.g. .claude/skills/orchestrate/SKILL.md (`centurion tools` lists the tools it can use).',
    '  - Run `centurion` to start, and `centurion help --agent` for the full guide.',
    ...(notes.length ? ['', ...notes.map((n) => `Note: ${n}`)] : []),
  ];
}
