import { access, constants } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type Platform = 'linux' | 'macos' | 'windows' | 'other';

export function platform(): Platform {
  switch (process.platform) {
    case 'linux':
      return 'linux';
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    default:
      return 'other';
  }
}

export const isWindows = (): boolean => process.platform === 'win32';

export function executableExtensions(): readonly string[] {
  if (!isWindows()) return [''];
  const pathext = process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD';
  return ['', ...pathext.split(';').map((entry) => entry.trim().toLowerCase()).filter(Boolean)];
}

export async function findExecutable(name: string): Promise<string | undefined> {
  const entries = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  const extensions = executableExtensions();
  const hasExtension = path.extname(name) !== '';

  for (const entry of entries) {
    for (const extension of hasExtension ? [''] : extensions) {
      const candidate = path.join(entry, `${name}${extension}`);
      try {
        await access(candidate, isWindows() ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return undefined;
}

function windowsAppData(kind: 'local' | 'roaming'): string | undefined {
  const value = kind === 'local' ? process.env['LOCALAPPDATA'] : process.env['APPDATA'];
  return value !== undefined && value !== '' ? value : undefined;
}

export function configDirectory(): string {
  const override = process.env['VECTRAX_CONFIG_DIR'];
  if (override !== undefined && override !== '') return path.resolve(override);

  if (isWindows()) {
    const base = windowsAppData('roaming') ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'Vectrax');
  }

  const xdg = process.env['XDG_CONFIG_HOME'];
  if (xdg !== undefined && xdg !== '') return path.join(xdg, 'vectrax');

  if (platform() === 'macos') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Vectrax');
  }
  return path.join(os.homedir(), '.config', 'vectrax');
}

export function dataDirectory(): string {
  const override = process.env['VECTRAX_DATA_DIR'];
  if (override !== undefined && override !== '') return path.resolve(override);

  if (isWindows()) {
    const base = windowsAppData('local') ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'Vectrax');
  }

  const xdg = process.env['XDG_DATA_HOME'];
  if (xdg !== undefined && xdg !== '') return path.join(xdg, 'vectrax');

  if (platform() === 'macos') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Vectrax');
  }
  return path.join(os.homedir(), '.local', 'share', 'vectrax');
}

export function toolsDirectory(): string {
  return path.join(dataDirectory(), 'tools');
}

export function defaultDownloadDirectory(): string {
  return path.join(os.homedir(), 'Downloads', 'Vectrax');
}

export function architecture(): string {
  return process.arch;
}
