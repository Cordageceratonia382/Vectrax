export const ExitCode = {
  Ok: 0,
  Failure: 1,
  UsageError: 2,
  NetworkError: 3,
  FilesystemError: 4,
  NoResults: 5,
  PartialFailure: 6,
  Interrupted: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export type ErrorCode =
  | 'E_USAGE'
  | 'E_CONFIG'
  | 'E_URL_INVALID'
  | 'E_URL_BLOCKED'
  | 'E_HTTP'
  | 'E_NETWORK'
  | 'E_TIMEOUT'
  | 'E_FS'
  | 'E_NO_MEDIA'
  | 'E_CANCELLED'
  | 'E_INTERNAL';

export interface VectraxErrorOptions {
  code?: ErrorCode | undefined;
  exitCode?: ExitCodeValue | undefined;
  hint?: string | undefined;
  details?: Record<string, unknown> | undefined;
  cause?: unknown;
}

export class VectraxError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: ExitCodeValue;
  readonly hint: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, options: VectraxErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'VectraxError';
    this.code = options.code ?? 'E_INTERNAL';
    this.exitCode = options.exitCode ?? ExitCode.Failure;
    this.hint = options.hint;
    this.details = options.details;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.hint !== undefined ? { hint: this.hint } : {}),
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export class UsageError extends VectraxError {
  constructor(message: string, options: Omit<VectraxErrorOptions, 'code' | 'exitCode'> = {}) {
    super(message, { ...options, code: 'E_USAGE', exitCode: ExitCode.UsageError });
    this.name = 'UsageError';
  }
}

export class ConfigError extends VectraxError {
  constructor(message: string, options: Omit<VectraxErrorOptions, 'code' | 'exitCode'> = {}) {
    super(message, { ...options, code: 'E_CONFIG', exitCode: ExitCode.UsageError });
    this.name = 'ConfigError';
  }
}

export class NetworkError extends VectraxError {
  constructor(
    message: string,
    options: Omit<VectraxErrorOptions, 'exitCode'> & { code?: ErrorCode } = {},
  ) {
    super(message, { ...options, code: options.code ?? 'E_NETWORK', exitCode: ExitCode.NetworkError });
    this.name = 'NetworkError';
  }
}

export function shortenUrl(url: string, maxLength = 72): string {
  if (url.length <= maxLength) return url;
  try {
    const parsed = new URL(url);
    const base = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    if (base.length <= maxLength) return parsed.search === '' ? base : `${base}?…`;
    return `${base.slice(0, maxLength - 1)}…`;
  } catch {
    return `${url.slice(0, maxLength - 1)}…`;
  }
}

export class HttpError extends NetworkError {
  readonly status: number;

  constructor(status: number, url: string, options: Omit<VectraxErrorOptions, 'code'> = {}) {
    super(`HTTP ${status} for ${shortenUrl(url)}`, {
      ...options,
      code: 'E_HTTP',
      details: { status, url, ...options.details },
    });
    this.name = 'HttpError';
    this.status = status;
  }
}

export class FilesystemError extends VectraxError {
  constructor(message: string, options: Omit<VectraxErrorOptions, 'code' | 'exitCode'> = {}) {
    super(message, { ...options, code: 'E_FS', exitCode: ExitCode.FilesystemError });
    this.name = 'FilesystemError';
  }
}

export class CancelledError extends VectraxError {
  constructor(message = 'Cancelled by user.') {
    super(message, { code: 'E_CANCELLED', exitCode: ExitCode.Interrupted });
    this.name = 'CancelledError';
  }
}

export function isVectraxError(value: unknown): value is VectraxError {
  return value instanceof VectraxError;
}

export function isAbortError(value: unknown): boolean {
  return value instanceof CancelledError || (value instanceof Error && value.name === 'AbortError');
}

export function isTimeoutError(value: unknown): boolean {
  return value instanceof Error && value.name === 'TimeoutError';
}

export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function wrapFsError(error: unknown, action: string, target: string): FilesystemError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const hints: Record<string, string> = {
    EACCES: 'Check the directory permissions, or choose a different output path.',
    EPERM: 'Check the directory permissions, or choose a different output path.',
    ENOSPC: 'The disk is full. Free up space or pick another volume.',
    EROFS: 'The target filesystem is read-only.',
    ENOENT: 'A parent directory does not exist.',
    ENOTDIR: 'A path component is a file, not a directory.',
    EMFILE: 'Too many open files. Lower --concurrency.',
    EXDEV: 'Source and destination are on different filesystems.',
  };
  return new FilesystemError(`Failed to ${action}: ${target} (${code ?? errorMessage(error)})`, {
    ...(code !== undefined && hints[code] !== undefined ? { hint: hints[code] } : {}),
    details: { errno: code, target },
    cause: error,
  });
}
