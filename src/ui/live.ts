import { ansi } from './theme.js';
import { displayWidth } from '../core/util/format.js';
import { usableColumns, usableRows } from './layout.js';

export interface LiveRegionOptions {
  stream?: NodeJS.WriteStream;
  frameIntervalMs?: number;
  reservedRows?: number;
}

export class LiveRegion {
  private readonly stream: NodeJS.WriteStream;
  private readonly frameIntervalMs: number;
  private readonly reservedRows: number;

  private lines: string[] = [];
  private renderedCount = 0;
  private lastFrame = '';
  private timer: NodeJS.Timeout | undefined;
  private lastRenderAt = 0;
  private active = false;
  private readonly onResize = () => {
    this.lastFrame = '';
    this.flush();
  };

  constructor(options: LiveRegionOptions = {}) {
    this.stream = options.stream ?? process.stderr;
    this.frameIntervalMs = options.frameIntervalMs ?? 80;
    this.reservedRows = options.reservedRows ?? 1;
  }

  get supported(): boolean {
    return this.stream.isTTY === true;
  }

  get columns(): number {
    return usableColumns(this.stream);
  }

  get maxRows(): number {
    return Math.max(1, usableRows(this.stream) - this.reservedRows);
  }

  start(): void {
    if (!this.supported || this.active) return;
    this.active = true;
    this.stream.write(ansi.hideCursor);
    this.stream.on('resize', this.onResize);
  }

  update(lines: readonly string[]): void {
    this.lines = lines.slice(0, this.maxRows);
    if (!this.active) return;

    const now = Date.now();
    const elapsed = now - this.lastRenderAt;
    if (elapsed >= this.frameIntervalMs) {
      this.flush();
      return;
    }
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.frameIntervalMs - elapsed).unref();
  }

  flush(): void {
    if (!this.active) return;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    const frame = this.lines.join('\n');
    if (frame === this.lastFrame && this.renderedCount === this.lines.length) return;
    this.lastFrame = frame;
    this.lastRenderAt = Date.now();

    const width = this.columns - (process.platform === 'win32' ? 1 : 0);
    let out = this.renderedCount > 0 ? ansi.cursorUp(this.renderedCount) + ansi.cursorHome : '';

    for (const line of this.lines) {
      out += `${ansi.clearLine}${clip(line, width)}\n`;
    }

    const surplus = this.renderedCount - this.lines.length;
    if (surplus > 0) {
      out += `${ansi.clearLine}\n`.repeat(surplus) + ansi.cursorUp(surplus);
    }

    this.stream.write(out);
    this.renderedCount = this.lines.length;
  }

  stop(persist = true): void {
    if (!this.active) return;
    this.flush();

    if (!persist && this.renderedCount > 0) {
      this.stream.write(ansi.cursorUp(this.renderedCount) + ansi.cursorHome);
      this.stream.write(`${ansi.clearLine}\n`.repeat(this.renderedCount));
      this.stream.write(ansi.cursorUp(this.renderedCount));
    }

    this.stream.removeListener('resize', this.onResize);
    this.stream.write(ansi.showCursor);
    this.active = false;
    this.renderedCount = 0;
    this.lastFrame = '';
  }
}

const ESC = '\u001B';

function clip(line: string, width: number): string {
  let used = 0;
  let index = 0;
  let out = '';

  while (index < line.length) {
    if (line[index] === ESC) {
      const end = line.indexOf('m', index);
      if (end === -1) break;
      out += line.slice(index, end + 1);
      index = end + 1;
      continue;
    }

    const char = String.fromCodePoint(line.codePointAt(index) as number);
    const charWidth = displayWidth(char);
    if (used + charWidth > width) {
      return `${out}${ansi.reset}`;
    }
    out += char;
    used += charWidth;
    index += char.length;
  }
  return out;
}
