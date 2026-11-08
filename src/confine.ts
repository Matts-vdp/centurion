import { realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * Paths confined to a root folder, and the small helpers the Files panel and git routes share.
 * Every path the UI sends is relative to one of the agent's roots and must stay inside it (links included).
 */

export class FileError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A response that isn't JSON (an image's bytes). */
export class RawBody {
  constructor(
    readonly type: string,
    readonly body: Buffer,
  ) {}
}

/** Text reads and diffs stop here. */
export const MAX_TEXT = 1024 * 1024;

/** The path's parts, refusing absolute paths and "..". */
export function relParts(rel: string): string[] {
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) throw new FileError(400, 'The path must be relative to the folder');
  const parts = rel.split(/[\\/]+/).filter((p) => p && p !== '.');
  if (parts.includes('..')) throw new FileError(400, 'The path may not contain ".."');
  return parts;
}

/** The absolute path of `rel` inside `root`, refusing anything that resolves outside it. */
export async function resolveInside(root: string, rel: string, mustExist = true): Promise<string> {
  const full = path.join(root, ...relParts(rel));
  if (!mustExist) return full;
  let real: string;
  let realRoot: string;
  try {
    [real, realRoot] = await Promise.all([realpath(full), realpath(root)]);
  } catch {
    throw new FileError(404, `Not found: ${rel || '.'}`);
  }
  if (!isInside(realRoot, real)) throw new FileError(403, 'That path leads outside the folder');
  return full;
}

export function isInside(root: string, p: string): boolean {
  const a = process.platform === 'win32' ? root.toLowerCase() : root;
  const b = process.platform === 'win32' ? p.toLowerCase() : p;
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

export function countLines(text: string): number {
  if (!text) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}
