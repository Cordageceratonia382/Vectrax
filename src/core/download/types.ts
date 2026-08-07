export interface DownloadRequest {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly outputDir: string;
  readonly referer?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly expectedSize?: number | undefined;
  readonly filename?: string | undefined;
  readonly failureHint?: string | undefined;
}

export type TaskState =
  | 'queued'
  | 'probing'
  | 'downloading'
  | 'retrying'
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'cancelled';

export interface TaskSnapshot {
  readonly id: string;
  readonly title: string;
  readonly state: TaskState;
  readonly received: number;
  readonly total: number | undefined;
  readonly speed: number;
  readonly etaMs: number | undefined;
  readonly resumedFrom: number;
  readonly attempt: number;
  readonly destination: string | undefined;
  readonly error: string | undefined;
}

export interface DownloadOutcome {
  readonly request: DownloadRequest;
  readonly state: Extract<TaskState, 'completed' | 'skipped' | 'failed' | 'cancelled'>;
  readonly path: string | undefined;
  readonly bytes: number;
  readonly durationMs: number;
  readonly resumed: boolean;
  readonly error: Error | undefined;
}

export type ConflictPolicy = 'rename' | 'skip' | 'overwrite';
