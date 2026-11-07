import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** The installed package's folder (the repo root in development): the nearest folder above this file with Centurion's package.json. */
function findPackageRoot(): string {
  let dir = import.meta.dirname;
  for (;;) {
    const file = path.join(dir, 'package.json');
    if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).name === 'centurion') return dir;
    const up = path.dirname(dir);
    if (up === dir) throw new Error(`Centurion's package.json not found above ${import.meta.dirname}`);
    dir = up;
  }
}

export const packageRoot = findPackageRoot();

export const packageVersion: string = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;

/** The packaged default prompts (`<kind>.md`). */
export const packagedPromptsDir = path.join(packageRoot, 'prompts');

/** The built UI (`npm run build`). */
export const uiDir = path.join(packageRoot, 'dist', 'ui');

/** The agent guide's template (`centurion help --agent`). */
export const guideFile = path.join(packageRoot, 'guide', 'agent.md');

/** The folder in a managing repo that holds Centurion's config, prompts and state. */
export const HOME_DIR = '.centurion';
