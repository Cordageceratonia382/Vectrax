import { displayWidth, truncate } from '../core/util/format.js';

export type Breakpoint = 'micro' | 'compact' | 'normal' | 'wide';

export const MICRO_MAX = 44;
export const COMPACT_MAX = 72;
export const NORMAL_MAX = 108;

export function breakpointFor(columns: number): Breakpoint {
  if (columns <= MICRO_MAX) return 'micro';
  if (columns <= COMPACT_MAX) return 'compact';
  if (columns <= NORMAL_MAX) return 'normal';
  return 'wide';
}

export function usableColumns(stream: NodeJS.WriteStream): number {
  const columns = stream.columns;
  return columns !== undefined && columns > 0 ? columns : 80;
}

export function usableRows(stream: NodeJS.WriteStream): number {
  const rows = stream.rows;
  return rows !== undefined && rows > 0 ? rows : 24;
}

export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];

  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let current = '';
    for (const word of paragraph.split(/\s+/).filter((part) => part !== '')) {
      const candidate = current === '' ? word : `${current} ${word}`;
      if (displayWidth(candidate) <= width) {
        current = candidate;
        continue;
      }
      if (current !== '') lines.push(current);
      current = displayWidth(word) > width ? truncate(word, width) : word;
    }
    lines.push(current);
  }
  return lines.length > 0 ? lines : [''];
}

export function indentAll(lines: readonly string[], indent: string): string[] {
  return lines.map((line) => `${indent}${line}`);
}

export interface ColumnPlan {
  readonly title: number;
  readonly bar: number;
  readonly showStats: boolean;
  readonly showRate: boolean;
  readonly showEta: boolean;
}

export function planColumns(columns: number): ColumnPlan {
  switch (breakpointFor(columns)) {
    case 'micro':
      return { title: Math.max(8, columns - 12), bar: 0, showStats: false, showRate: false, showEta: false };
    case 'compact':
      return { title: Math.max(10, columns - 26), bar: 10, showStats: false, showRate: false, showEta: false };
    case 'normal':
      return { title: Math.max(14, columns - 52), bar: 16, showStats: true, showRate: false, showEta: false };
    default:
      return { title: Math.max(20, columns - 70), bar: 22, showStats: true, showRate: true, showEta: true };
  }
}

export function fit(text: string, width: number): string {
  const clipped = truncate(text, width);
  const pad = width - displayWidth(clipped);
  return pad > 0 ? clipped + ' '.repeat(pad) : clipped;
}
