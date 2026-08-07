import { setTimeout as sleep } from 'node:timers/promises';

import {
  HttpError,
  NetworkError,
  VectraxError,
  errorMessage,
  isAbortError,
  isTimeoutError,
  shortenUrl,
} from '../errors.js';
import { assertUrlAllowed, isCrossOrigin, type UrlGuardOptions } from './guard.js';

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface HttpClientOptions {
  userAgent?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  maxRedirects?: number;
  guard?: UrlGuardOptions;
  onRetry?: (info: RetryInfo) => void;
}

export interface RetryInfo {
  url: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
}

export interface RequestOptions {
  method?: 'GET' | 'HEAD' | 'POST';
  headers?: Record<string, string>;
  body?: string | Uint8Array | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
  retries?: number;
  retryStatuses?: readonly number[];
  referer?: string | undefined;
}

export interface HttpResponse {
  readonly response: Response;
  readonly url: URL;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

export class HttpClient {
  private readonly userAgent: string;
  private readonly baseHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly maxRedirects: number;
  private readonly guard: UrlGuardOptions;
  private readonly onRetry: ((info: RetryInfo) => void) | undefined;

  constructor(options: HttpClientOptions = {}) {
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.baseHeaders = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retries = options.retries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 600;
    this.maxRedirects = options.maxRedirects ?? 8;
    this.guard = options.guard ?? {};
    this.onRetry = options.onRetry;
  }

  async request(target: URL | string, options: RequestOptions = {}): Promise<HttpResponse> {
    const maxAttempts = (options.retries ?? this.retries) + 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this.requestOnce(target, options);
        const retryable =
          RETRYABLE_STATUS.has(result.response.status) ||
          options.retryStatuses?.includes(result.response.status) === true;
        if (attempt < maxAttempts && retryable) {
          await result.response.body?.cancel().catch(() => undefined);
          const delayMs = this.backoff(attempt, result.response.headers.get('retry-after'));
          this.onRetry?.({
            url: String(target),
            attempt,
            maxAttempts,
            delayMs,
            reason: `HTTP ${result.response.status}`,
          });
          await sleep(delayMs, undefined, { signal: options.signal });
          continue;
        }
        return result;
      } catch (error) {
        if (isAbortError(error) || error instanceof VectraxError) throw error;
        lastError = error;
        if (attempt >= maxAttempts) break;
        const delayMs = this.backoff(attempt, null);
        this.onRetry?.({
          url: String(target),
          attempt,
          maxAttempts,
          delayMs,
          reason: errorMessage(error),
        });
        await sleep(delayMs, undefined, { signal: options.signal });
      }
    }

    const timedOut = isTimeoutError(lastError);
    throw new NetworkError(
      timedOut
        ? `Timed out waiting for ${shortenUrl(String(target))} to respond.`
        : `Request failed: ${errorMessage(lastError)}`,
      {
        code: timedOut ? 'E_TIMEOUT' : 'E_NETWORK',
        hint: timedOut
          ? 'The server did not send response headers in time. Raise --timeout if the host is simply slow.'
          : 'Check your connection, or increase --timeout / --retries.',
        details: { url: String(target) },
        cause: lastError,
      },
    );
  }

  private backoff(attempt: number, retryAfter: string | null): number {
    return computeBackoff(attempt, this.retryDelayMs, retryAfter);
  }

  private async requestOnce(target: URL | string, options: RequestOptions): Promise<HttpResponse> {
    let url = target instanceof URL ? new URL(target.href) : new URL(target);
    let referer = options.referer;
    let method = options.method ?? 'GET';
    let body = options.body;
    const origin = new URL(url.href);

    for (let hop = 0; hop <= this.maxRedirects; hop++) {
      assertUrlAllowed(url, this.guard);

      const headers = new Headers({
        'user-agent': this.userAgent,
        'accept-language': 'en;q=0.9,*;q=0.5',
        ...this.baseHeaders,
        ...options.headers,
      });
      if (referer !== undefined && referer !== '') headers.set('referer', referer);

      const timeoutMs = options.timeoutMs ?? this.timeoutMs;

      const headerTimeout = new AbortController();
      const timer = setTimeout(
        () => headerTimeout.abort(new DOMException('Timed out waiting for response headers', 'TimeoutError')),
        timeoutMs,
      );

      const signals = [headerTimeout.signal];
      if (options.signal !== undefined) signals.push(options.signal);

      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers,
          redirect: 'manual',
          signal: AbortSignal.any(signals),
          ...(body !== undefined && method === 'POST' ? { body } : {}),
        });
      } finally {
        clearTimeout(timer);
      }

      if (!isRedirect(response.status)) {
        return { response, url };
      }

      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (location === null || location === '') {
        throw new HttpError(response.status, url.href, {
          hint: 'The server sent a redirect without a Location header.',
        });
      }

      const next = new URL(location, url);
      if (url.protocol === 'https:' && next.protocol === 'http:') {
        throw new VectraxError(`Refusing insecure redirect from ${url.host} to ${next.href}`, {
          code: 'E_URL_BLOCKED',
          hint: 'The server tried to downgrade the connection to plaintext HTTP.',
        });
      }
      if (isCrossOrigin(origin, next)) referer = undefined;

      if (method === 'POST' && response.status !== 307 && response.status !== 308) {
        method = 'GET';
        body = undefined;
      }
      url = next;
    }

    throw new NetworkError(`Too many redirects (>${this.maxRedirects}) starting at ${String(target)}`, {
      hint: 'The server is redirecting in a loop.',
    });
  }

  async requestOk(target: URL | string, options: RequestOptions = {}): Promise<HttpResponse> {
    const result = await this.request(target, options);
    if (!result.response.ok) {
      await result.response.body?.cancel().catch(() => undefined);
      throw new HttpError(result.response.status, result.url.href, {
        hint: httpStatusHint(result.response.status),
      });
    }
    return result;
  }

  async text(target: URL | string, options: RequestOptions = {}): Promise<{ body: string; url: URL }> {
    const { response, url } = await this.requestOk(target, {
      ...options,
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...options.headers,
      },
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    return { body: decodeBody(buffer, response.headers.get('content-type')), url };
  }

  async json<T = unknown>(target: URL | string, options: RequestOptions = {}): Promise<T> {
    const { response, url } = await this.requestOk(target, {
      ...options,
      headers: { accept: 'application/json', ...options.headers },
    });
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new NetworkError(`Expected JSON from ${url.host} but got something else.`, {
        hint: 'The service may be rate-limiting or returning an error page.',
        details: { url: url.href, preview: text.slice(0, 120) },
        cause: error,
      });
    }
  }

  async buffer(
    target: URL | string,
    options: RequestOptions & {
      maxBytes?: number;
      onProgress?: (received: number, total: number | undefined) => void;
    } = {},
  ): Promise<{ data: Buffer; contentType: string | null }> {
    const { response, url } = await this.requestOk(target, options);
    const declared = Number(response.headers.get('content-length'));
    const total = Number.isFinite(declared) && declared > 0 ? declared : undefined;
    const limit = options.maxBytes ?? 32 * 1024 * 1024;

    if (total !== undefined && total > limit) {
      await response.body?.cancel().catch(() => undefined);
      throw new NetworkError(`Refusing to buffer ${total} bytes from ${url.host} (limit ${limit}).`);
    }

    if (options.onProgress === undefined || response.body === null) {
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length > limit) {
        throw new NetworkError(`Response from ${url.host} exceeded the ${limit}-byte buffer limit.`);
      }
      return { data, contentType: response.headers.get('content-type') };
    }

    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.byteLength;
      if (received > limit) {
        throw new NetworkError(`Response from ${url.host} exceeded the ${limit}-byte buffer limit.`);
      }
      chunks.push(Buffer.from(chunk));
      options.onProgress(received, total);
    }

    return { data: Buffer.concat(chunks), contentType: response.headers.get('content-type') };
  }

  async probe(target: URL | string, options: RequestOptions = {}): Promise<ProbeResult> {
    try {
      const head = await this.request(target, { ...options, method: 'HEAD', retries: 0 });
      await head.response.body?.cancel().catch(() => undefined);
      if (head.response.ok) return readProbe(head.response, head.url);
    } catch {}

    const probe = await this.request(target, {
      ...options,
      method: 'GET',
      headers: { ...options.headers, range: 'bytes=0-0' },
      retries: 0,
    });
    await probe.response.body?.cancel().catch(() => undefined);
    if (!probe.response.ok) {
      throw new HttpError(probe.response.status, probe.url.href, {
        hint: httpStatusHint(probe.response.status),
      });
    }
    return readProbe(probe.response, probe.url);
  }
}

export interface ProbeResult {
  url: URL;
  size: number | undefined;
  contentType: string | null;
  contentDisposition: string | null;
  etag: string | null;
  lastModified: string | null;
  supportsRanges: boolean;
}

function readProbe(response: Response, url: URL): ProbeResult {
  const headers = response.headers;
  const contentRange = headers.get('content-range');
  const totalFromRange = contentRange !== null ? Number(contentRange.split('/')[1]) : Number.NaN;
  const contentLength = Number(headers.get('content-length'));

  const size = Number.isFinite(totalFromRange)
    ? totalFromRange
    : response.status !== 206 && Number.isFinite(contentLength) && contentLength > 0
      ? contentLength
      : undefined;

  return {
    url,
    size,
    contentType: headers.get('content-type'),
    contentDisposition: headers.get('content-disposition'),
    etag: headers.get('etag'),
    lastModified: headers.get('last-modified'),
    supportsRanges: response.status === 206 || headers.get('accept-ranges')?.includes('bytes') === true,
  };
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export function computeBackoff(attempt: number, baseMs: number, retryAfter: string | null): number {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 30_000);
  }
  const ceiling = Math.min(baseMs * 2 ** (attempt - 1), 15_000);
  return Math.round(ceiling * (0.5 + Math.random() * 0.5));
}

export function httpStatusHint(status: number): string | undefined {
  if (status === 401 || status === 403) {
    return 'The server rejected the request. It may require a session cookie or a specific Referer (--referer).';
  }
  if (status === 404) return 'The resource no longer exists at that URL.';
  if (status === 429) return 'Rate limited. Lower --concurrency or retry later.';
  if (status >= 500) return 'The server is failing. Try again shortly.';
  return undefined;
}

export function decodeBody(buffer: Buffer, contentType: string | null): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
  const head = buffer.subarray(0, 4096).toString('latin1');
  const fromMeta =
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ??
    /<\?xml[^>]+encoding=["']([\w-]+)/i.exec(head)?.[1];

  for (const charset of [fromHeader, fromMeta, 'utf-8']) {
    if (charset === undefined) continue;
    try {
      return new TextDecoder(charset, { fatal: false }).decode(buffer);
    } catch {}
  }
  return buffer.toString('utf8');
}
