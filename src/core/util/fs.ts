import { constants } from 'node:fs';
import { access, mkdir, rename, copyFile, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { FilesystemError, wrapFsError } from '../errors.js';

export function resolvePath(input: string): string {
  const trimmed = stripSurroundingQuotes(input.trim());
  const expanded =
    trimmed === '~' || trimmed.startsWith(`~${path.sep}`) || trimmed.startsWith('~/')
      ? path.join(os.homedir(), trimmed.slice(1))
      : trimmed;
  return path.resolve(expanded);
}

export function stripSurroundingQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1);
  }
  return value;
}

export async function ensureDir(dir: string): Promise<string> {
  try {
    await mkdir(dir, { recursive: true });
    return dir;
  } catch (error) {
    throw wrapFsError(error, 'create directory', dir);
  }
}

export async function ensureWritableDir(dir: string): Promise<string> {
  await ensureDir(dir);
  try {
    await access(dir, constants.W_OK | constants.X_OK);
  } catch (error) {
    throw new FilesystemError(`Directory is not writable: ${dir}`, {
      hint: 'Pick a different --output directory or fix its permissions.',
      cause: error,
    });
  }
  return dir;
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function fileSize(target: string): Promise<number> {
  try {
    const info = await stat(target);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

export async function removeQuietly(target: string): Promise<void> {
  try {
    await unlink(target);
  } catch {}
}

export async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV') throw wrapFsError(error, 'move file', from);
  }
  try {
    await copyFile(from, to);
    await unlink(from);
  } catch (error) {
    throw wrapFsError(error, 'move file across devices', from);
  }
}

export async function uniquePath(dir: string, filename: string, maxAttempts = 1000): Promise<string> {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  for (let n = 2; n <= maxAttempts; n++) {
    if (!(await pathExists(candidate))) return candidate;
    candidate = path.join(dir, `${base} (${n})${ext}`);
  }
  throw new FilesystemError(`Could not find a free filename for "${filename}" in ${dir}`, {
    hint: 'Clear out the directory or use --overwrite.',
  });
}

export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
