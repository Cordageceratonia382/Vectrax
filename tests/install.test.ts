import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { HttpClient } from '../src/core/http/client.js';
import {
  manualInstruction,
  parseChecksums,
  performInstall,
  planInstall,
  standaloneAsset,
  type DownloadPlan,
} from '../src/core/fallback/install.js';
import {
  configDirectory,
  dataDirectory,
  executableExtensions,
  findExecutable,
  platform,
  toolsDirectory,
} from '../src/core/util/platform.js';

const BINARY = Buffer.from('#!/bin/sh\necho stub-yt-dlp\n');
const DIGEST = createHash('sha256').update(BINARY).digest('hex');

let dir: string;
let binDir: string;
const savedEnv: Record<string, string | undefined> = {};

function saveEnv(...keys: string[]): void {
  for (const key of keys) savedEnv[key] = process.env[key];
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function withPlatform(value: NodeJS.Platform, fn: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value, configurable: true });
  try {
    fn();
  } finally {
    if (descriptor !== undefined) Object.defineProperty(process, 'platform', descriptor);
  }
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'vectrax-install-'));
  binDir = path.join(dir, 'bin');
  await mkdir(binDir, { recursive: true });
  saveEnv('PATH', 'VECTRAX_DATA_DIR', 'VECTRAX_CONFIG_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'PATHEXT');
});

afterEach(async () => {
  restoreEnv();
  await rm(dir, { recursive: true, force: true });
});

const SYSTEM_PATH = process.env['PATH'] ?? '';

async function stub(name: string, body: string): Promise<string> {
  const file = path.join(binDir, name);
  await writeFile(file, `#!/usr/bin/env bash\n${body}\n`);
  await chmod(file, 0o755);
  process.env['PATH'] = `${binDir}${path.delimiter}${SYSTEM_PATH}`;
  return file;
}

describe('platform directories', () => {
  it('honours explicit overrides', () => {
    process.env['VECTRAX_DATA_DIR'] = path.join(dir, 'data');
    process.env['VECTRAX_CONFIG_DIR'] = path.join(dir, 'conf');
    expect(dataDirectory()).toBe(path.join(dir, 'data'));
    expect(configDirectory()).toBe(path.join(dir, 'conf'));
    expect(toolsDirectory()).toBe(path.join(dir, 'data', 'tools'));
  });

  it('uses XDG locations on Linux', () => {
    withPlatform('linux', () => {
      delete process.env['VECTRAX_DATA_DIR'];
      delete process.env['VECTRAX_CONFIG_DIR'];
      process.env['XDG_DATA_HOME'] = '/xdg/data';
      process.env['XDG_CONFIG_HOME'] = '/xdg/config';
      expect(dataDirectory()).toBe(path.join('/xdg/data', 'vectrax'));
      expect(configDirectory()).toBe(path.join('/xdg/config', 'vectrax'));
    });
  });

  it('reports the running platform', () => {
    withPlatform('win32', () => expect(platform()).toBe('windows'));
    withPlatform('darwin', () => expect(platform()).toBe('macos'));
    withPlatform('linux', () => expect(platform()).toBe('linux'));
    withPlatform('freebsd', () => expect(platform()).toBe('other'));
  });
});

describe('executable lookup', () => {
  it('finds an executable on PATH', async () => {
    const file = await stub('vectrax-probe', 'echo hi');
    expect(await findExecutable('vectrax-probe')).toBe(file);
  });

  it('returns undefined when it is absent', async () => {
    process.env['PATH'] = binDir;
    expect(await findExecutable('definitely-not-installed-xyz')).toBeUndefined();
  });

  it('considers PATHEXT suffixes on Windows', () => {
    withPlatform('win32', () => {
      process.env['PATHEXT'] = '.COM;.EXE;.BAT;.CMD';
      const extensions = executableExtensions();
      expect(extensions).toContain('.exe');
      expect(extensions).toContain('.cmd');
      expect(extensions[0]).toBe('');
    });
  });

  it('uses a bare name on POSIX', () => {
    withPlatform('linux', () => expect(executableExtensions()).toEqual(['']));
  });
});

describe('standaloneAsset', () => {
  it('maps each platform to a published asset', () => {
    withPlatform('win32', () => expect(standaloneAsset()).toBe('yt-dlp.exe'));
    withPlatform('darwin', () => expect(standaloneAsset()).toBe('yt-dlp_macos'));
    withPlatform('linux', () => expect(standaloneAsset()).toMatch(/^yt-dlp_linux/));
  });

  it('gives a platform-appropriate manual command', () => {
    withPlatform('win32', () => expect(manualInstruction()).toContain('winget'));
    withPlatform('darwin', () => expect(manualInstruction()).toContain('brew'));
    withPlatform('linux', () => expect(manualInstruction()).toContain('pipx'));
  });
});

describe('planInstall', () => {
  it('prefers a package manager that is already installed', async () => {
    await stub('pipx', 'exit 0');

    const plan = await planInstall();
    expect(plan?.kind).toBe('manager');
    expect(plan?.description).toContain('pipx install yt-dlp');
  });

  it('falls back to the official binary when no manager exists', async () => {
    process.env['PATH'] = binDir;
    process.env['VECTRAX_DATA_DIR'] = path.join(dir, 'data');

    const plan = await planInstall();
    expect(plan?.kind).toBe('download');
    expect((plan as DownloadPlan).url).toContain('github.com/yt-dlp/yt-dlp/releases');
    expect((plan as DownloadPlan).destination).toContain(path.join('data', 'tools'));
  });

  it('always offers a manual command to fall back on', async () => {
    process.env['PATH'] = binDir;
    const plan = await planInstall();
    expect(plan?.manual).toBeTruthy();
  });
});

describe('parseChecksums', () => {
  it('reads the published SHA2-256SUMS format', () => {
    const sums = parseChecksums(`${'a'.repeat(64)}  yt-dlp_linux\n${'b'.repeat(64)} *yt-dlp.exe`);
    expect(sums.get('yt-dlp_linux')).toBe('a'.repeat(64));
    expect(sums.get('yt-dlp.exe')).toBe('b'.repeat(64));
  });

  it('ignores malformed lines', () => {
    expect(parseChecksums('nonsense\n\n# comment').size).toBe(0);
  });
});

describe('performInstall', () => {
  let server: Server;
  let origin: string;
  let serveDigest = DIGEST;
  let serveSums = true;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/SHA2-256SUMS') {
        if (!serveSums) {
          res.writeHead(404).end();
          return;
        }
        const body = Buffer.from(`${serveDigest}  yt-dlp_linux\n`);
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': body.length });
        res.end(body);
        return;
      }
      if (url.pathname === '/yt-dlp_linux') {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': BINARY.length });
        res.end(BINARY);
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    serveDigest = DIGEST;
    serveSums = true;
  });

  const client = () => new HttpClient({ guard: { allowPrivateHosts: true }, retries: 0 });

  const downloadPlan = (): DownloadPlan => ({
    kind: 'download',
    id: 'standalone',
    asset: 'yt-dlp_linux',
    url: `${origin}/yt-dlp_linux`,
    checksumUrl: `${origin}/SHA2-256SUMS`,
    destination: path.join(dir, 'tools', 'yt-dlp'),
    description: 'download',
    manual: 'pipx install yt-dlp',
  });

  it('installs a verified binary and makes it executable', async () => {
    const plan = downloadPlan();
    const steps: string[] = [];
    await performInstall(client(), plan, { onStep: (m) => steps.push(m) });

    expect(await readFile(plan.destination)).toEqual(BINARY);
    expect(steps.join(' ')).toMatch(/checksum/i);
  });

  it('refuses a binary whose checksum does not match', async () => {
    serveDigest = 'f'.repeat(64);
    const plan = downloadPlan();

    await expect(performInstall(client(), plan, {})).rejects.toThrow(/checksum/i);
    await expect(readFile(plan.destination)).rejects.toThrow();
  });

  it('leaves no partial file behind on failure', async () => {
    serveDigest = 'f'.repeat(64);
    const plan = downloadPlan();
    await performInstall(client(), plan, {}).catch(() => undefined);
    await expect(readFile(`${plan.destination}.partial`)).rejects.toThrow();
  });

  it('continues when the checksum list is unavailable', async () => {
    serveSums = false;
    const plan = downloadPlan();
    const steps: string[] = [];
    await performInstall(client(), plan, { onStep: (m) => steps.push(m) });

    expect(await readFile(plan.destination)).toEqual(BINARY);
    expect(steps.join(' ')).toMatch(/without verification/i);
  });

  it('reports download progress', async () => {
    const seen: number[] = [];
    await performInstall(client(), downloadPlan(), { onProgress: (r) => seen.push(r) });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBeCloseTo(1, 5);
  });

  it('runs a package manager plan and surfaces its output', async () => {
    const command = await stub('fake-manager', 'echo installing yt-dlp; exit 0');
    const steps: string[] = [];

    await performInstall(client(), {
      kind: 'manager',
      id: 'fake',
      command,
      args: ['install'],
      description: 'fake-manager install',
      manual: 'fake-manager install',
    }, { onStep: (m) => steps.push(m) });

    expect(steps.join(' ')).toContain('installing yt-dlp');
  });

  it('reports a package manager that fails', async () => {
    const command = await stub('failing-manager', 'echo "E: permission denied" >&2; exit 1');

    await expect(
      performInstall(client(), {
        kind: 'manager',
        id: 'fake',
        command,
        args: ['install'],
        description: 'failing-manager install',
        manual: 'failing-manager install',
      }, {}),
    ).rejects.toMatchObject({ hint: expect.stringContaining('permission denied') });
  });

  it('never invokes a shell', async () => {
    const command = await stub('echo-args', 'printf "%s\\n" "$@"');
    const steps: string[] = [];

    await performInstall(client(), {
      kind: 'manager',
      id: 'fake',
      command,
      args: ['install', '; rm -rf /tmp/should-not-happen'],
      description: 'echo-args',
      manual: 'echo-args',
    }, { onStep: (m) => steps.push(m) });

    expect(steps).toContain('; rm -rf /tmp/should-not-happen');
  });
});
