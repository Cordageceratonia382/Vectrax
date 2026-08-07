import { c, glyph, stripAnsi } from './theme.js';
import { usableColumns, wrap } from './layout.js';

export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export interface LoggerOptions {
  level?: LogLevel;
  json?: boolean;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

export class Logger {
  level: LogLevel;
  readonly json: boolean;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.json = options.json ?? false;
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
  }

  get isInteractive(): boolean {
    return this.stderr.isTTY === true && !this.json && this.level !== 'silent';
  }

  get columns(): number {
    const stdout = this.stdout.columns;
    return stdout !== undefined && stdout > 0 ? stdout : usableColumns(this.stderr);
  }

  private enabled(level: Exclude<LogLevel, 'silent'>): boolean {
    return LEVEL_RANK[this.level] >= LEVEL_RANK[level];
  }

  private emit(
    level: Exclude<LogLevel, 'silent'>,
    label: string,
    message: string,
    fields?: Record<string, unknown>,
  ): void {
    if (!this.enabled(level)) return;
    if (this.json) {
      this.stderr.write(`${JSON.stringify({ level, message, ...fields })}\n`);
      return;
    }
    this.stderr.write(`${label} ${message}\n`);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.emit('info', c.accent(glyph.info), c.text(message), fields);
  }

  step(message: string, fields?: Record<string, unknown>): void {
    this.emit('info', c.accentDeep(glyph.pointer), c.text(message), fields);
  }

  success(message: string, fields?: Record<string, unknown>): void {
    this.emit('info', c.success(glyph.tick), c.text(message), fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.emit('warn', c.warn(glyph.warn), c.text(message), fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.emit('error', c.danger(glyph.cross), c.text(message), fields);
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.emit('debug', c.muted(glyph.bullet), c.muted(message), fields);
  }

  detail(message: string): void {
    if (!this.enabled('info') || this.json) return;
    for (const line of wrap(message, Math.max(20, this.columns - 2))) {
      this.stderr.write(`  ${c.muted(line)}\n`);
    }
  }

  blank(): void {
    if (!this.enabled('info') || this.json) return;
    this.stderr.write('\n');
  }

  field(label: string, value: string): void {
    if (!this.enabled('info') || this.json) return;
    const gutter = 14;
    const [first, ...rest] = wrap(value, Math.max(16, this.columns - gutter));
    this.stderr.write(`  ${c.muted(label.padEnd(11))} ${c.text(first ?? '')}\n`);
    for (const line of rest) this.stderr.write(`${' '.repeat(gutter)}${c.text(line)}\n`);
  }

  heading(title: string): void {
    if (!this.enabled('info') || this.json) return;
    this.stderr.write(`\n${c.accent(glyph.lineV)} ${c.bold(c.text(title.toUpperCase()))}\n`);
  }

  result(text: string): void {
    this.stdout.write(`${this.stdout.isTTY === true ? text : stripAnsi(text)}\n`);
  }

  resultJson(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  }
}
