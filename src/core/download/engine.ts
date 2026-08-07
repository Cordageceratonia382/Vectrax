import { createWriteStream } from 'node:fs';
import { readFile, writeFile, rename, truncate as truncateFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  CancelledError,
  HttpError,
  VectraxError,
  errorMessage,
  isAbortError,
  wrapFsError,
} from '../errors.js';
import { computeBackoff, httpStatusHint, type HttpClient } from '../http/client.js';
import { buildFilename } from './filename.js';
import { ensureWritableDir, fileSize, moveFile, pathExists, removeQuietly, uniquePath } from '../util/fs.js';
import { mapPool, delay } from '../util/pool.js';
import type { ConflictPolicy, DownloadOutcome, DownloadRequest, TaskSnapshot, TaskState } from './types.js';

const PART_SUFFIX = '.vxpart';
const META_SUFFIX = '.vxpart.json';

export interface DownloadEngineOptions {
  concurrency?: number;
  retries?: number;
  retryDelayMs?: number;
  stallTimeoutMs?: number;
  conflict?: ConflictPolicy;
  resume?: boolean;
  dryRun?: boolean;
  onUpdate?: (snapshot: TaskSnapshot) => void;
}

interface PartMetadata {
  url: string;
  etag: string | null;
  lastModified: string | null;
  size: number | null;
  version: 1;
}

class Task {
  state: TaskState = 'queued';
  received = 0;
  total: number | undefined;
  resumedFrom = 0;
  attempt = 1;
  destination: string | undefined;
  error: string | undefined;

  private speed = 0;
  private lastSampleAt = 0;
  private lastSampleBytes = 0;

  constructor(readonly request: DownloadRequest) {}

  beginSampling(now: number, baseline: number): void {
    this.lastSampleAt = now;
    this.lastSampleBytes = baseline;
    this.speed = 0;
  }

  sample(now: number): void {
    const elapsed = now - this.lastSampleAt;
    if (elapsed < 150) return;
    const instant = ((this.received - this.lastSampleBytes) * 1000) / elapsed;
    this.speed = this.speed === 0 ? instant : this.speed * 0.7 + instant * 0.3;
    this.lastSampleAt = now;
    this.lastSampleBytes = this.received;
  }

  snapshot(): TaskSnapshot {
    const remaining = this.total !== undefined ? this.total - this.received : undefined;
    return {
      id: this.request.id,
      title: this.request.title,
      state: this.state,
      received: this.received,
      total: this.total,
      speed: this.state === 'downloading' ? this.speed : 0,
      etaMs:
        remaining !== undefined && remaining > 0 && this.speed > 1
          ? (remaining / this.speed) * 1000
          : undefined,
      resumedFrom: this.resumedFrom,
      attempt: this.attempt,
      destination: this.destination,
      error: this.error,
    };
  }
}

export class DownloadEngine {
  private readonly concurrency: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly stallTimeoutMs: number;
  private readonly conflict: ConflictPolicy;
  private readonly resume: boolean;
  private readonly dryRun: boolean;
  private readonly onUpdate: ((snapshot: TaskSnapshot) => void) | undefined;

  constructor(
    private readonly http: HttpClient,
    options: DownloadEngineOptions = {},
  ) {
    this.concurrency = Math.max(1, options.concurrency ?? 4);
    this.retries = Math.max(0, options.retries ?? 3);
    this.retryDelayMs = options.retryDelayMs ?? 800;
    this.stallTimeoutMs = options.stallTimeoutMs ?? 60_000;
    this.conflict = options.conflict ?? 'rename';
    this.resume = options.resume ?? true;
    this.dryRun = options.dryRun ?? false;
    this.onUpdate = options.onUpdate;
  }

  async run(requests: readonly DownloadRequest[], signal?: AbortSignal): Promise<DownloadOutcome[]> {
    if (requests.length === 0) return [];

    const outputDirs = new Set(requests.map((request) => request.outputDir));
    for (const dir of outputDirs) await ensureWritableDir(dir);

    const settled = await mapPool(
      requests,
      async (request) => this.runTask(new Task(request), signal),
      { limit: this.concurrency, signal },
    );

    return settled.map((entry, index) => {
      if (entry.status === 'fulfilled') return entry.value;
      const request = requests[index] as DownloadRequest;
      const cancelled = isAbortError(entry.reason) || signal?.aborted === true;
      return {
        request,
        state: cancelled ? 'cancelled' : 'failed',
        path: undefined,
        bytes: 0,
        durationMs: 0,
        resumed: false,
        error: entry.reason instanceof Error ? entry.reason : new Error(errorMessage(entry.reason)),
      };
    });
  }

  private publish(task: Task): void {
    this.onUpdate?.(task.snapshot());
  }

  private async runTask(task: Task, signal?: AbortSignal): Promise<DownloadOutcome> {
    const startedAt = Date.now();
    const finish = (
      state: DownloadOutcome['state'],
      extra: Partial<DownloadOutcome> = {},
    ): DownloadOutcome => {
      task.state = state;
      this.publish(task);
      return {
        request: task.request,
        state,
        path: task.destination,
        bytes: task.received,
        durationMs: Date.now() - startedAt,
        resumed: task.resumedFrom > 0,
        error: undefined,
        ...extra,
      };
    };

    try {
      task.state = 'probing';
      this.publish(task);

      const probe = await this.http.probe(task.request.url, {
        signal,
        ...(task.request.headers !== undefined ? { headers: { ...task.request.headers } } : {}),
        ...(task.request.referer !== undefined ? { referer: task.request.referer } : {}),
      });

      task.total = probe.size ?? task.request.expectedSize;

      const filename = buildFilename({
        title: task.request.filename ?? task.request.title,
        url: probe.url,
        contentDisposition: probe.contentDisposition,
        contentType: probe.contentType,
      });

      const resolved = await this.resolveDestination(task.request.outputDir, filename);
      if (resolved === null) {
        task.destination = path.join(task.request.outputDir, filename);
        return finish('skipped');
      }
      task.destination = resolved;

      if (this.dryRun) {
        task.received = task.total ?? 0;
        return finish('completed');
      }

      await this.transferWithRetry(task, probe, signal);
      return finish('completed');
    } catch (error) {
      if (isAbortError(error) || signal?.aborted === true) {
        task.error = 'cancelled';
        return finish('cancelled', { error: new CancelledError() });
      }
      const failure = this.explain(error, task.request);
      task.error = failure.message;
      return finish('failed', { error: failure });
    }
  }

  private explain(error: unknown, request: DownloadRequest): Error {
    const normalised = error instanceof Error ? error : new Error(errorMessage(error));
    if (request.failureHint === undefined) return normalised;
    if (!(normalised instanceof HttpError) || (normalised.status !== 401 && normalised.status !== 403)) {
      return normalised;
    }
    return new HttpError(normalised.status, String(normalised.details?.['url'] ?? request.url), {
      hint: request.failureHint,
      cause: normalised,
    });
  }

  private async resolveDestination(outputDir: string, filename: string): Promise<string | null> {
    const direct = path.join(outputDir, filename);
    if (!(await pathExists(direct))) return direct;
    switch (this.conflict) {
      case 'skip':
        return null;
      case 'overwrite':
        return direct;
      case 'rename':
        return uniquePath(outputDir, filename);
    }
  }

  private async transferWithRetry(
    task: Task,
    probe: Awaited<ReturnType<HttpClient['probe']>>,
    signal?: AbortSignal,
  ): Promise<void> {
    const destination = task.destination as string;
    const partPath = `${destination}${PART_SUFFIX}`;
    const metaPath = `${destination}${META_SUFFIX}`;
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.retries + 1; attempt++) {
      task.attempt = attempt;
      try {
        const offset = await this.resolveResumeOffset(partPath, metaPath, probe);
        task.resumedFrom = offset;
        task.received = offset;
        task.state = 'downloading';
        this.publish(task);

        await this.transfer(task, probe, partPath, metaPath, offset, signal);
        await this.finalize(task, partPath, metaPath, destination);
        return;
      } catch (error) {
        if (isAbortError(error) || signal?.aborted === true) throw error;
        if (error instanceof HttpError && error.status < 500 && error.status !== 408 && error.status !== 429) {
          throw error;
        }
        lastError = error;
        if (attempt > this.retries) break;

        task.state = 'retrying';
        task.error = errorMessage(error);
        this.publish(task);
        await delay(computeBackoff(attempt, this.retryDelayMs, null), signal);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(errorMessage(lastError));
  }

  private async resolveResumeOffset(
    partPath: string,
    metaPath: string,
    probe: Awaited<ReturnType<HttpClient['probe']>>,
  ): Promise<number> {
    const existing = await fileSize(partPath);
    if (existing === 0) return 0;

    if (!this.resume || !probe.supportsRanges) {
      await removeQuietly(partPath);
      await removeQuietly(metaPath);
      return 0;
    }

    const meta = await readMetadata(metaPath);
    const matches =
      meta !== undefined &&
      meta.url === probe.url.href &&
      meta.etag === probe.etag &&
      meta.lastModified === probe.lastModified &&
      meta.size === (probe.size ?? null);

    const sane = probe.size === undefined || existing < probe.size;

    if (matches && sane) return existing;

    await removeQuietly(partPath);
    await removeQuietly(metaPath);
    return 0;
  }

  private async transfer(
    task: Task,
    probe: Awaited<ReturnType<HttpClient['probe']>>,
    partPath: string,
    metaPath: string,
    offset: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const headers: Record<string, string> = { accept: '*/*', ...task.request.headers };
    if (offset > 0) headers['range'] = `bytes=${offset}-`;

    const { response } = await this.http.request(probe.url, {
      method: 'GET',
      headers,
      signal,
      retries: 0,
      ...(task.request.referer !== undefined ? { referer: task.request.referer } : {}),
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 416) {
        await removeQuietly(partPath);
        await removeQuietly(metaPath);
      }
      throw new HttpError(response.status, probe.url.href, { hint: httpStatusHint(response.status) });
    }

    const resuming = offset > 0 && response.status === 206;
    if (offset > 0 && !resuming) {
      await truncateFile(partPath, 0).catch(() => removeQuietly(partPath));
      task.resumedFrom = 0;
      task.received = 0;
    }

    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > 0) {
      task.total = (resuming ? offset : 0) + declared;
    }

    if (response.body === null) {
      throw new VectraxError('The server returned an empty response body.', { code: 'E_HTTP' });
    }

    await writeMetadata(metaPath, {
      url: probe.url.href,
      etag: probe.etag,
      lastModified: probe.lastModified,
      size: probe.size ?? null,
      version: 1,
    });

    const stallController = new AbortController();
    let lastByteAt = Date.now();
    task.beginSampling(lastByteAt, task.received);
    const watchdog = setInterval(() => {
      if (Date.now() - lastByteAt > this.stallTimeoutMs) {
        stallController.abort(new Error(`Stalled: no data for ${Math.round(this.stallTimeoutMs / 1000)}s`));
      }
    }, 1000).unref();

    const signals = [stallController.signal];
    if (signal !== undefined) signals.push(signal);

    const counter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        task.received += chunk.length;
        lastByteAt = Date.now();
        task.sample(lastByteAt);
        this.publish(task);
        callback(null, chunk);
      },
    });

    const sink = createWriteStream(partPath, { flags: resuming ? 'a' : 'w' });

    try {
      await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), counter, sink, {
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      if (stallController.signal.aborted && signal?.aborted !== true) {
        throw new VectraxError(errorMessage(stallController.signal.reason), {
          code: 'E_TIMEOUT',
          hint: 'The connection stalled. Re-run to resume from where it stopped.',
        });
      }
      throw error;
    } finally {
      clearInterval(watchdog);
    }
  }

  private async finalize(task: Task, partPath: string, metaPath: string, destination: string): Promise<void> {
    const written = await fileSize(partPath);

    if (task.total !== undefined && task.total > 0 && written !== task.total) {
      throw new VectraxError(
        `Incomplete download: expected ${task.total} bytes, wrote ${written}.`,
        { code: 'E_NETWORK', hint: 'Re-run to resume the transfer.' },
      );
    }
    if (written === 0) {
      await removeQuietly(partPath);
      await removeQuietly(metaPath);
      throw new VectraxError('The server returned an empty file.', { code: 'E_HTTP' });
    }

    try {
      await rename(partPath, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') await moveFile(partPath, destination);
      else throw wrapFsError(error, 'finalize download', destination);
    }
    await removeQuietly(metaPath);

    task.received = written;
    task.total = written;
  }
}

async function readMetadata(metaPath: string): Promise<PartMetadata | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(metaPath, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && (parsed as PartMetadata).version === 1) {
      return parsed as PartMetadata;
    }
  } catch {}
  return undefined;
}

async function writeMetadata(metaPath: string, meta: PartMetadata): Promise<void> {
  try {
    await writeFile(metaPath, JSON.stringify(meta), 'utf8');
  } catch {}
}
