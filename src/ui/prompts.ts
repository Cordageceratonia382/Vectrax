import { readdir } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import { CancelledError, UsageError } from '../core/errors.js';
import { displayWidth, truncate } from '../core/util/format.js';
import { LiveRegion } from './live.js';
import { c, glyph } from './theme.js';

const input = process.stdin;
const output = process.stderr;

export function isInteractiveSession(): boolean {
  return input.isTTY === true && output.isTTY === true;
}

function requireTty(what: string, flag: string): void {
  if (isInteractiveSession()) return;
  throw new UsageError(`${what} requires an interactive terminal.`, {
    hint: `Re-run with ${flag} to answer this non-interactively.`,
  });
}

interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

function withKeys<T>(handler: (ctx: { resolve: (value: T) => void; reject: (error: unknown) => void }) => {
  onKey: (str: string | undefined, key: Key) => void;
  render: () => void;
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const wasRaw = input.isRaw === true;
    readline.emitKeypressEvents(input);
    if (input.isTTY) input.setRawMode(true);
    input.resume();

    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      input.removeListener('keypress', onKeypress);
      if (input.isTTY) input.setRawMode(wasRaw);
      input.pause();
    };

    const api = {
      resolve: (value: T) => {
        cleanup();
        resolve(value);
      },
      reject: (error: unknown) => {
        cleanup();
        reject(error);
      },
    };

    const { onKey, render } = handler(api);

    const onKeypress = (str: string | undefined, key: Key = {}) => {
      if (key.ctrl === true && key.name === 'c') {
        api.reject(new CancelledError());
        return;
      }
      onKey(str, key);
    };

    input.on('keypress', onKeypress);
    render();
  });
}

export interface ConfirmOptions {
  message: string;
  initial?: boolean;
  flag?: string;
}

export async function confirm(options: ConfirmOptions): Promise<boolean> {
  requireTty('Confirmation', options.flag ?? '--yes');
  let value = options.initial ?? true;
  const region = new LiveRegion({ stream: output, frameIntervalMs: 0, reservedRows: 0 });
  region.start();

  const draw = () => {
    const yes = value ? c.onAccent(' yes ') : c.muted(' yes ');
    const no = value ? c.muted(' no ') : c.onAccent(' no ');
    region.update([`${c.accent(glyph.pointer)} ${c.bold(c.text(options.message))}  ${yes} ${no}`]);
  };

  try {
    return await withKeys<boolean>(({ resolve, reject }) => ({
      render: draw,
      onKey: (str, key) => {
        const name = key.name ?? '';
        if (name === 'left' || name === 'right' || name === 'tab' || name === 'h' || name === 'l') {
          value = !value;
          draw();
        } else if (str?.toLowerCase() === 'y') {
          value = true;
          resolve(true);
        } else if (str?.toLowerCase() === 'n') {
          value = false;
          resolve(false);
        } else if (name === 'return' || name === 'enter') {
          resolve(value);
        } else if (name === 'escape') {
          reject(new CancelledError());
        }
      },
    }));
  } finally {
    region.stop(false);
    output.write(
      `${c.accent(glyph.pointer)} ${c.muted(options.message)} ${c.accentBright(value ? 'yes' : 'no')}\n`,
    );
  }
}

export interface TextOptions {
  message: string;
  placeholder?: string;
  initial?: string;
  hint?: string;
  validate?: (value: string) => string | undefined;
  flag?: string;
}

export async function text(options: TextOptions): Promise<string> {
  requireTty('Text input', options.flag ?? '--output');
  let value = options.initial ?? '';
  let error: string | undefined;
  const region = new LiveRegion({ stream: output, frameIntervalMs: 0, reservedRows: 0 });
  region.start();

  const draw = () => {
    const shown =
      value === ''
        ? c.muted(options.placeholder ?? '')
        : c.text(value) + c.accent(glyph.barFull);
    const lines = [`${c.accent(glyph.pointer)} ${c.bold(c.text(options.message))} ${shown}`];
    if (error !== undefined) lines.push(`  ${c.danger(glyph.cross)} ${c.danger(error)}`);
    else if (options.hint !== undefined) lines.push(`  ${c.muted(options.hint)}`);
    region.update(lines);
  };

  try {
    return await withKeys<string>(({ resolve, reject }) => ({
      render: draw,
      onKey: (str, key) => {
        const name = key.name ?? '';
        if (name === 'return' || name === 'enter') {
          const message = options.validate?.(value);
          if (message !== undefined) {
            error = message;
            draw();
            return;
          }
          resolve(value);
          return;
        }
        if (name === 'escape') {
          reject(new CancelledError());
          return;
        }
        if (name === 'backspace') {
          value = [...value].slice(0, -1).join('');
        } else if (key.ctrl === true && name === 'u') {
          value = '';
        } else if (key.ctrl === true && name === 'w') {
          value = value.replace(/\S+\s*$/, '');
        } else if (str !== undefined && key.ctrl !== true && key.meta !== true && !/[\u0000-\u001F\u007F]/.test(str)) {
          value += str;
        } else {
          return;
        }
        error = undefined;
        draw();
      },
    }));
  } finally {
    region.stop(false);
    output.write(`${c.accent(glyph.pointer)} ${c.muted(options.message)} ${c.accentBright(value)}\n`);
  }
}

export interface SelectItem<T> {
  value: T;
  label: string;
  hint?: string | undefined;
  selected?: boolean;
}

export interface MultiSelectOptions<T> {
  message: string;
  items: readonly SelectItem<T>[];
  required?: boolean;
  flag?: string;
}

export async function multiSelect<T>(options: MultiSelectOptions<T>): Promise<T[]> {
  requireTty('Selection', options.flag ?? '--all or --select');
  if (options.items.length === 0) return [];

  const selected = new Set<number>(
    options.items.flatMap((item, index) => (item.selected === true ? [index] : [])),
  );
  let cursor = 0;
  let offset = 0;
  let error: string | undefined;

  const region = new LiveRegion({ stream: output, frameIntervalMs: 0, reservedRows: 1 });
  region.start();

  const pageSize = () => Math.max(3, Math.min(options.items.length, region.maxRows - 4));

  const draw = () => {
    const size = pageSize();
    if (cursor < offset) offset = cursor;
    if (cursor >= offset + size) offset = cursor - size + 1;
    offset = Math.max(0, Math.min(offset, options.items.length - size));

    const columns = region.columns;
    const lines = [
      `${c.accent(glyph.pointer)} ${c.bold(c.text(options.message))} ${c.muted(`(${selected.size}/${options.items.length} selected)`)}`,
    ];

    for (let index = offset; index < Math.min(offset + size, options.items.length); index++) {
      const item = options.items[index] as SelectItem<T>;
      const isCursor = index === cursor;
      const isChecked = selected.has(index);

      const box = isChecked ? c.accent(glyph.checkOn) : c.muted(glyph.checkOff);
      const pointer = isCursor ? c.accent(glyph.pointer) : ' ';
      const number = c.muted(String(index + 1).padStart(String(options.items.length).length));
      const hint = item.hint ?? '';

      const reserved = displayWidth(`  ${glyph.pointer} ${glyph.checkOn} ${number}  ${hint}  `);
      const label = truncate(item.label, Math.max(8, columns - reserved));
      const styled = isCursor ? c.bold(c.text(label)) : isChecked ? c.text(label) : c.muted(label);

      const pad = ' '.repeat(
        Math.max(1, columns - reserved - displayWidth(label) + 1),
      );
      lines.push(`  ${pointer} ${box} ${number} ${styled}${pad}${c.muted(hint)}`);
    }

    if (options.items.length > size) {
      lines.push(c.muted(`    ${offset + 1}–${Math.min(offset + size, options.items.length)} of ${options.items.length}`));
    }
    lines.push(
      error !== undefined
        ? `  ${c.danger(glyph.cross)} ${c.danger(error)}`
        : c.muted(`    space toggle  ${glyph.bullet}  a all  ${glyph.bullet}  i invert  ${glyph.bullet}  enter confirm  ${glyph.bullet}  esc cancel`),
    );

    region.update(lines);
  };

  try {
    return await withKeys<T[]>(({ resolve, reject }) => ({
      render: draw,
      onKey: (str, key) => {
        const name = key.name ?? '';
        const last = options.items.length - 1;

        if (name === 'up' || name === 'k') cursor = cursor === 0 ? last : cursor - 1;
        else if (name === 'down' || name === 'j') cursor = cursor === last ? 0 : cursor + 1;
        else if (name === 'pageup') cursor = Math.max(0, cursor - pageSize());
        else if (name === 'pagedown') cursor = Math.min(last, cursor + pageSize());
        else if (name === 'home') cursor = 0;
        else if (name === 'end') cursor = last;
        else if (name === 'space') {
          if (selected.has(cursor)) selected.delete(cursor);
          else selected.add(cursor);
          error = undefined;
        } else if (str === 'a') {
          if (selected.size === options.items.length) selected.clear();
          else options.items.forEach((_, index) => selected.add(index));
          error = undefined;
        } else if (str === 'i') {
          options.items.forEach((_, index) => {
            if (selected.has(index)) selected.delete(index);
            else selected.add(index);
          });
          error = undefined;
        } else if (name === 'return' || name === 'enter') {
          if (options.required === true && selected.size === 0) {
            error = 'Select at least one item, or press esc to cancel.';
            draw();
            return;
          }
          resolve(
            [...selected].sort((a, b) => a - b).map((index) => (options.items[index] as SelectItem<T>).value),
          );
          return;
        } else if (name === 'escape' || str === 'q') {
          reject(new CancelledError());
          return;
        } else {
          return;
        }
        draw();
      },
    }));
  } finally {
    region.stop(false);
    output.write(
      `${c.accent(glyph.pointer)} ${c.muted(options.message)} ${c.accentBright(`${selected.size} selected`)}\n`,
    );
  }
}

export interface BrowseOptions {
  message: string;
  startPath?: string;
}

export async function browseDirectory(options: BrowseOptions): Promise<string> {
  requireTty('Directory browsing', '--output <dir>');

  let current = path.resolve(options.startPath ?? process.cwd());
  let entries: string[] = [];
  let cursor = 0;
  let offset = 0;
  let notice: string | undefined;

  const region = new LiveRegion({ stream: output, frameIntervalMs: 0, reservedRows: 1 });
  region.start();

  const pageSize = () => Math.max(3, Math.min(20, region.maxRows - 5));

  const load = async (dir: string): Promise<void> => {
    try {
      const found = await readdir(dir, { withFileTypes: true });
      entries = found
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
      current = dir;
      cursor = 0;
      offset = 0;
      notice = undefined;
    } catch {
      notice = 'Cannot read that directory.';
    }
  };

  const draw = () => {
    const size = pageSize();
    if (cursor < offset) offset = cursor;
    if (cursor >= offset + size) offset = cursor - size + 1;

    const lines = [
      `${c.accent(glyph.pointer)} ${c.bold(c.text(options.message))}`,
      `  ${c.muted(truncate(current, region.columns - 4))}`,
    ];

    if (entries.length === 0) {
      lines.push(`  ${c.muted('(no sub-directories)')}`);
    }
    for (let index = offset; index < Math.min(offset + size, entries.length); index++) {
      const name = entries[index] as string;
      const isCursor = index === cursor;
      const pointer = isCursor ? c.accent(glyph.pointer) : ' ';
      const label = truncate(name, region.columns - 8);
      lines.push(`  ${pointer} ${c.accentDeep(glyph.arrow)} ${isCursor ? c.bold(c.text(label)) : c.muted(label)}`);
    }

    lines.push(
      notice !== undefined
        ? `  ${c.danger(glyph.cross)} ${c.danger(notice)}`
        : c.muted(`    ${glyph.arrow} enter open  ${glyph.bullet}  ← up  ${glyph.bullet}  s select this folder  ${glyph.bullet}  esc cancel`),
    );
    region.update(lines);
  };

  await load(current);

  try {
    return await withKeys<string>(({ resolve, reject }) => ({
      render: draw,
      onKey: (str, key) => {
        const name = key.name ?? '';
        const last = entries.length - 1;

        if (name === 'up' || name === 'k') cursor = cursor <= 0 ? Math.max(0, last) : cursor - 1;
        else if (name === 'down' || name === 'j') cursor = cursor >= last ? 0 : cursor + 1;
        else if (name === 'left' || name === 'backspace') {
          const parent = path.dirname(current);
          if (parent !== current) void load(parent).then(draw);
          return;
        } else if (name === 'right' || name === 'return' || name === 'enter') {
          const target = entries[cursor];
          if (target === undefined) return;
          void load(path.join(current, target)).then(draw);
          return;
        } else if (str === 's' || (key.ctrl === true && name === 'd')) {
          resolve(current);
          return;
        } else if (name === 'escape' || str === 'q') {
          reject(new CancelledError());
          return;
        } else {
          return;
        }
        draw();
      },
    }));
  } finally {
    region.stop(false);
  }
}
