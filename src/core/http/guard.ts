import { isIP } from 'node:net';

import { VectraxError, ExitCode } from '../errors.js';

export interface UrlGuardOptions {
  allowPrivateHosts?: boolean;
  allowInsecure?: boolean;
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export function parseUrl(input: string, options: UrlGuardOptions = {}): URL {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new VectraxError('No URL provided.', {
      code: 'E_URL_INVALID',
      exitCode: ExitCode.UsageError,
      hint: 'Pass a page or file URL, e.g. vectrax get "https://example.com/album".',
    });
  }

  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new VectraxError(`Not a valid URL: ${input}`, {
      code: 'E_URL_INVALID',
      exitCode: ExitCode.UsageError,
      hint: 'Include the scheme, e.g. https://example.com/page.',
    });
  }

  assertUrlAllowed(url, options);
  return url;
}

export function assertUrlAllowed(url: URL, options: UrlGuardOptions = {}): void {
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new VectraxError(`Unsupported URL scheme "${url.protocol}".`, {
      code: 'E_URL_BLOCKED',
      exitCode: ExitCode.UsageError,
      hint: 'Vectrax only fetches http:// and https:// URLs.',
      details: { url: url.href },
    });
  }

  if (url.protocol === 'http:' && options.allowInsecure === false) {
    throw new VectraxError(`Refusing plaintext HTTP request to ${url.host}.`, {
      code: 'E_URL_BLOCKED',
      exitCode: ExitCode.UsageError,
      hint: 'Pass --insecure to allow http:// URLs.',
      details: { url: url.href },
    });
  }

  if (options.allowPrivateHosts !== true && isPrivateHost(url.hostname)) {
    throw new VectraxError(`Refusing to connect to private address "${url.hostname}".`, {
      code: 'E_URL_BLOCKED',
      exitCode: ExitCode.UsageError,
      hint: 'Pass --allow-private if you intend to reach a host on your own network.',
      details: { url: url.href },
    });
  }
}

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '' || host === '0.0.0.0') return true;

  const version = isIP(host);

  if (version === 4) {
    const parts = host.split('.').map(Number);
    const [a = 0, b = 0] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }

  if (version === 6) {
    if (host === '::' || host === '::1') return true;
    if (host.startsWith('fe80')) return true;
    if (/^f[cd]/.test(host)) return true;
    const mapped = /^::ffff:(.+)$/.exec(host);
    if (mapped?.[1] !== undefined && isIP(mapped[1]) === 4) return isPrivateHost(mapped[1]);
    return false;
  }

  return false;
}

export function normalizeUrl(url: URL): string {
  const clone = new URL(url.href);
  clone.hash = '';
  clone.searchParams.sort();
  if ((clone.protocol === 'https:' && clone.port === '443') || (clone.protocol === 'http:' && clone.port === '80')) {
    clone.port = '';
  }
  return clone.href;
}

export function isCrossOrigin(from: URL, to: URL): boolean {
  return from.protocol !== to.protocol || from.host !== to.host;
}
