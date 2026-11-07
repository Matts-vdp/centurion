// `npm prepare`: builds the server and the UI, so `npm i -g github:...` installs a working command.
// npm runs this in a temporary clone for git installs. With `-g`, it passes its global settings on, so the clone
// gets no dev dependencies (Vite, TypeScript). Install them locally first when they are missing, then build.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^npm_config_(global|location|prefix|omit|production)$/i.test(key)) delete env[key];
}

function npm(args) {
  const result = spawnSync('npm', args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync('node_modules/vite') || !existsSync('node_modules/typescript')) {
  npm(['install', '--include=dev', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund']);
}
npm(['run', 'build']);
