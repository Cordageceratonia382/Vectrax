import { LiveRegion } from './live.js';
import type { Logger } from './logger.js';
import { c, glyph } from './theme.js';
import { reactionEdge } from './chemistry.js';
import { breakpointFor, fit, planColumns } from './layout.js';
import {
  displayWidth,
  formatBytes,
  formatEta,
  formatPercent,
  formatRate,
  padStart,
  renderBar,
  truncate,
} from '../core/util/format.js';
import type { TaskSnapshot } from '../core/download/types.js';

const BAR_GLYPHS = { full: glyph.barFull, partial: glyph.barPartial, empty: glyph.barEmpty };

export interface DashboardOptions {
  logger: Logger;
  total: number;
  plain?: boolean;
}

interface Aggregate {
  completed: number;
  skipped: number;
  failed: number;
  settled: number;
  active: TaskSnapshot[];
  received: number;
  totalBytes: number;
  speed: number;
  etaMs: number | undefined;
}

export class DownloadDashboard {
  private readonly logger: Logger;
  private readonly total: number;
  private readonly live: LiveRegion;
  private readonly interactive: boolean;
  private readonly tasks = new Map<string, TaskSnapshot>();
  private readonly announced = new Set<string>();

  private ticker: NodeJS.Timeout | undefined;
  private pulse = 0;

  constructor(options: DashboardOptions) {
    this.logger = options.logger;
    this.total = options.total;
    this.live = new LiveRegion({ stream: options.logger.stderr, frameIntervalMs: 80, reservedRows: 2 });
    this.interactive = options.plain !== true && this.live.supported && options.logger.isInteractive;
  }

  start(): void {
    if (!this.interactive) return;
    this.live.start();
    this.ticker = setInterval(() => {
      this.pulse++;
      this.render();
    }, 90).unref();
  }

  handle(snapshot: TaskSnapshot): void {
    this.tasks.set(snapshot.id, snapshot);
    if (this.interactive) this.render();
    else this.announce(snapshot);
  }

  stop(): void {
    if (this.ticker !== undefined) clearInterval(this.ticker);
    this.ticker = undefined;
    if (this.interactive) this.live.stop(false);
  }

  private announce(snapshot: TaskSnapshot): void {
    const settled =
      snapshot.state === 'completed' || snapshot.state === 'failed' || snapshot.state === 'skipped';
    if (!settled || this.announced.has(snapshot.id)) return;
    this.announced.add(snapshot.id);

    const position = `[${this.announced.size}/${this.total}]`;
    if (snapshot.state === 'completed') {
      this.logger.success(`${position} ${snapshot.title} ${c.muted(`(${formatBytes(snapshot.received)})`)}`);
    } else if (snapshot.state === 'skipped') {
      this.logger.info(`${position} ${snapshot.title} ${c.muted('(already present, skipped)')}`);
    } else {
      this.logger.error(`${position} ${snapshot.title} ${c.muted(`— ${snapshot.error ?? 'failed'}`)}`);
    }
  }

  private aggregate(): Aggregate {
    const snapshots = [...this.tasks.values()];
    const completed = snapshots.filter((task) => task.state === 'completed').length;
    const skipped = snapshots.filter((task) => task.state === 'skipped').length;
    const failed = snapshots.filter((task) => task.state === 'failed').length;
    const active = snapshots.filter(
      (task) => task.state === 'downloading' || task.state === 'probing' || task.state === 'retrying',
    );

    const received = snapshots.reduce((sum, task) => sum + task.received, 0);
    const totalBytes = snapshots.reduce((sum, task) => sum + (task.total ?? task.received), 0);
    const speed = active.reduce((sum, task) => sum + task.speed, 0);
    const remaining = totalBytes - received;

    return {
      completed,
      skipped,
      failed,
      settled: completed + skipped + failed,
      active,
      received,
      totalBytes,
      speed,
      etaMs: speed > 1 && remaining > 0 ? (remaining / speed) * 1000 : undefined,
    };
  }

  private render(): void {
    const columns = this.live.columns;
    const size = breakpointFor(columns);
    const stats = this.aggregate();

    const lines = [this.renderHeader(stats, columns)];

    const windowSize = Math.max(1, this.live.maxRows - (size === 'micro' ? 2 : 3));
    const visible = stats.active.slice(0, windowSize);
    for (const task of visible) lines.push(this.renderRow(task, columns));

    const hidden = stats.active.length - visible.length;
    if (hidden > 0) lines.push(c.muted(`  ${glyph.bullet} ${hidden} more in flight`));

    lines.push(this.renderFooter(stats, columns));
    this.live.update(lines);
  }

  private renderHeader(stats: Aggregate, columns: number): string {
    const ratio = stats.totalBytes > 0 ? stats.received / stats.totalBytes : 0;
    const size = breakpointFor(columns);
    const counter = c.text(`${stats.settled}/${this.total}`);
    const percent = c.bold(c.text(formatPercent(ratio)));

    if (size === 'micro') {
      return `  ${c.accent(glyph.barFull)} ${counter} ${percent}`;
    }

    const size_ = c.muted(`${formatBytes(stats.received)} / ${formatBytes(stats.totalBytes)}`);
    const rate = c.accentBright(padStart(formatRate(stats.speed), 10));
    const eta = c.muted(`eta ${formatEta(stats.etaMs)}`);

    const trailing = size === 'compact' ? size_ : `${size_}  ${rate}  ${eta}`;
    const fixed = displayWidth(`  ${glyph.barFull}  ${stats.settled}/${this.total}   100%    `);
    const barWidth = Math.max(6, Math.min(34, columns - fixed - displayWidth(trailing) - 4));
    const bar = this.reactiveBar(ratio, barWidth);

    return `  ${c.accent(glyph.barFull)}  ${counter}  ${bar}${percent}  ${trailing}`;
  }

  private reactiveBar(ratio: number, width: number): string {
    const bar = renderBar(ratio, width, BAR_GLYPHS);
    if (ratio <= 0 || ratio >= 1) return c.accent(bar);

    const filled = Math.floor(Math.min(1, Math.max(0, ratio)) * width);
    if (filled >= width) return c.accent(bar);

    const head = [...bar].slice(0, filled).join('');
    const tail = [...bar].slice(filled + 1).join('');
    return c.accent(head) + c.accentBright(reactionEdge(this.pulse)) + c.muted(tail);
  }

  private renderRow(task: TaskSnapshot, columns: number): string {
    const spinner = c.accent(glyph.spinner[this.pulse % glyph.spinner.length] as string);
    const plan = planColumns(columns);

    if (task.state === 'probing') {
      return `  ${spinner} ${c.text(truncate(task.title, plan.title))} ${c.muted('resolving')}`;
    }
    if (task.state === 'retrying') {
      return `  ${c.warn(glyph.warn)} ${c.text(truncate(task.title, plan.title))} ${c.warn(`retry ${task.attempt}`)}`;
    }

    const ratio = task.total !== undefined && task.total > 0 ? task.received / task.total : 0;
    const name = c.text(fit(task.title, plan.title));
    const resumed = task.resumedFrom > 0 ? c.info('↺') : '';

    const parts = [`  ${spinner} ${name}${resumed}`];
    if (plan.bar > 0) parts.push(this.reactiveBar(ratio, plan.bar));
    parts.push(c.text(formatPercent(ratio)));

    if (plan.showStats) {
      const total = task.total !== undefined ? ` / ${formatBytes(task.total)}` : '';
      parts.push(c.muted(`${formatBytes(task.received)}${total}`));
    }
    if (plan.showRate) parts.push(c.accentBright(padStart(formatRate(task.speed), 10)));
    if (plan.showEta) parts.push(c.muted(formatEta(task.etaMs)));

    return parts.join('  ');
  }

  private renderFooter(stats: Aggregate, columns: number): string {
    const queued = this.total - stats.settled - stats.active.length;
    const parts: string[] = [];

    if (queued > 0) parts.push(c.muted(`${queued} queued`));
    if (stats.completed > 0) parts.push(c.success(`${stats.completed} done`));
    if (stats.skipped > 0) parts.push(c.muted(`${stats.skipped} skipped`));
    if (stats.failed > 0) parts.push(c.danger(`${stats.failed} failed`));

    if (breakpointFor(columns) !== 'micro') parts.push(c.muted('ctrl+c stops, progress is kept'));
    return `  ${parts.join(c.muted(`  ${glyph.bullet}  `))}`;
  }
}
