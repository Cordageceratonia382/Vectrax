import { HttpClient } from '../core/http/client.js';
import { Logger, type LogLevel } from '../ui/logger.js';
import { resolveConfig, type ResolveConfigOptions } from '../config/store.js';
import type { Config, ConfigInput } from '../config/schema.js';

export interface GlobalFlags {
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  banner?: boolean;
  config?: string;
}

export interface CliContext {
  readonly config: Config;
  readonly logger: Logger;
  readonly http: HttpClient;
  readonly signal: AbortSignal;
  readonly flags: GlobalFlags;
}

function levelFor(flags: GlobalFlags): LogLevel {
  if (flags.quiet === true) return 'error';
  if (flags.verbose === true) return 'debug';
  return 'info';
}

export interface CreateContextOptions extends ResolveConfigOptions {
  flags: GlobalFlags;
  signal: AbortSignal;
  overrides?: Partial<ConfigInput>;
}

export async function createContext(options: CreateContextOptions): Promise<CliContext> {
  const logger = new Logger({
    level: levelFor(options.flags),
    json: options.flags.json ?? false,
  });

  const config = await resolveConfig({
    ...(options.overrides !== undefined ? { overrides: options.overrides } : {}),
    ...(options.flags.config !== undefined ? { file: options.flags.config } : {}),
    ...(options.file !== undefined ? { file: options.file } : {}),
  });

  const http = new HttpClient({
    userAgent: config.userAgent,
    timeoutMs: config.timeoutMs,
    retries: config.retries,
    guard: {
      allowPrivateHosts: config.allowPrivateHosts,
      allowInsecure: config.allowInsecure,
    },
    onRetry: (info) => {
      logger.debug(`retry ${info.attempt}/${info.maxAttempts - 1} in ${info.delayMs}ms — ${info.reason}`, {
        url: info.url,
      });
    },
  });

  return { config, logger, http, signal: options.signal, flags: options.flags };
}

export function createInterruptController(onFirst?: () => void): {
  controller: AbortController;
  dispose: () => void;
} {
  const controller = new AbortController();
  let interrupted = false;

  const handler = () => {
    if (interrupted) {
      process.stderr.write('\n');
      process.exit(130);
    }
    interrupted = true;
    onFirst?.();
    controller.abort(new Error('Interrupted by user'));
  };

  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);

  return {
    controller,
    dispose: () => {
      process.removeListener('SIGINT', handler);
      process.removeListener('SIGTERM', handler);
    },
  };
}
