import path from 'node:path';
import { writeFile } from 'node:fs/promises';

import { ExitCode, UsageError, VectraxError, errorMessage } from '../../core/errors.js';
import {
  artworkExtension,
  readArtworkFile,
  readTags,
  supportsTagging,
  toArtwork,
  writeTags,
} from '../../core/metadata/tags.js';
import {
  EDITABLE_FIELDS,
  FIELD_LABELS,
  NUMERIC_FIELDS,
  isEmptyMetadata,
  mergeMetadata,
  type EditableField,
  type TrackMetadata,
} from '../../core/metadata/types.js';
import { parseUrl } from '../../core/http/guard.js';
import { formatBytes, padEnd, truncate } from '../../core/util/format.js';
import { mapPool } from '../../core/util/pool.js';
import { pathExists } from '../../core/util/fs.js';
import { confirm, isInteractiveSession, text } from '../../ui/prompts.js';
import { c, glyph } from '../../ui/theme.js';
import type { CliContext } from '../context.js';

export interface TagOptions {
  set: string[] | undefined;
  artwork: string | undefined;
  removeArtwork: boolean;
  exportArtwork: string | undefined;
  clear: boolean;
  interactive: boolean;
  yes: boolean;
}

export function parseAssignments(assignments: readonly string[]): TrackMetadata {
  const metadata: TrackMetadata = {};

  for (const assignment of assignments) {
    const separator = assignment.indexOf('=');
    if (separator <= 0) {
      throw new UsageError(`--set expects "field=value" (got "${assignment}").`, {
        hint: `Editable fields: ${EDITABLE_FIELDS.join(', ')}.`,
      });
    }

    const rawField = assignment.slice(0, separator).trim();
    const value = assignment.slice(separator + 1).trim();
    const field = EDITABLE_FIELDS.find((known) => known.toLowerCase() === rawField.toLowerCase());

    if (field === undefined) {
      throw new UsageError(`Unknown metadata field "${rawField}".`, {
        hint: `Editable fields: ${EDITABLE_FIELDS.join(', ')}.`,
      });
    }

    if (NUMERIC_FIELDS.has(field)) {
      if (value === '') {
        Object.assign(metadata, { [field]: '' });
        continue;
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new UsageError(`${FIELD_LABELS[field]} must be a non-negative number (got "${value}").`);
      }
      Object.assign(metadata, { [field]: parsed });
    } else {
      Object.assign(metadata, { [field]: value });
    }
  }

  return metadata;
}

export async function runTag(ctx: CliContext, files: string[], options: TagOptions): Promise<number> {
  const updates = options.clear ? {} : parseAssignments(options.set ?? []);

  for (const file of files) {
    if (!(await pathExists(file))) {
      throw new VectraxError(`No such file: ${file}`, {
        code: 'E_FS',
        exitCode: ExitCode.FilesystemError,
      });
    }
  }

  if (options.exportArtwork !== undefined) return exportArtwork(ctx, files, options.exportArtwork);

  const hasEdits =
    (options.set !== undefined && options.set.length > 0) ||
    options.artwork !== undefined ||
    options.removeArtwork ||
    options.clear;

  if (options.interactive) {
    if (files.length !== 1) {
      throw new UsageError('--interactive edits one file at a time.', {
        hint: 'Pass a single file, or use --set for batch edits.',
      });
    }
    return editInteractively(ctx, files[0] as string, options);
  }

  if (!hasEdits) return showTags(ctx, files);

  return applyEdits(ctx, files, options, updates);
}

async function showTags(ctx: CliContext, files: readonly string[]): Promise<number> {
  const entries = await mapPool(
    files,
    async (file) => ({ file, metadata: await readTags(file) }),
    { limit: 4, signal: ctx.signal },
  );

  if (ctx.flags.json === true) {
    ctx.logger.resultJson(
      entries.map((entry, index) =>
        entry.status === 'fulfilled'
          ? {
              file: entry.value.file,
              taggable: supportsTagging(entry.value.file),
              tags: serialise(entry.value.metadata),
            }
          : { file: files[index], error: errorMessage(entry.reason) },
      ),
    );
    return ExitCode.Ok;
  }

  let failures = 0;
  entries.forEach((entry, index) => {
    if (entry.status === 'rejected') {
      failures++;
      ctx.logger.error(`${files[index]}: ${errorMessage(entry.reason)}`);
      return;
    }
    if (files.length > 1) {
      ctx.logger.blank();
      ctx.logger.result(c.accent(path.basename(entry.value.file)));
    }
    printTags(ctx, entry.value.metadata, entry.value.file);
  });

  return failures > 0 ? ExitCode.Failure : ExitCode.Ok;
}

function printTags(ctx: CliContext, metadata: TrackMetadata, file: string): void {
  if (isEmptyMetadata(metadata)) {
    ctx.logger.blank();
    ctx.logger.detail(
      supportsTagging(file) ? 'No metadata present.' : 'This container does not support tags.',
    );
    ctx.logger.blank();
    return;
  }

  ctx.logger.blank();
  const width = Math.max(...EDITABLE_FIELDS.map((field) => FIELD_LABELS[field].length));

  for (const field of EDITABLE_FIELDS) {
    const value = metadata[field];
    if (value === undefined || value === '') continue;
    ctx.logger.result(`  ${c.muted(padEnd(FIELD_LABELS[field], width))}  ${c.text(String(value))}`);
  }

  if (metadata.sourceUrl !== undefined) {
    ctx.logger.result(`  ${c.muted(padEnd('Source', width))}  ${c.text(metadata.sourceUrl)}`);
  }
  if (metadata.artwork !== undefined) {
    const { mime, data } = metadata.artwork;
    ctx.logger.result(
      `  ${c.muted(padEnd('Artwork', width))}  ${c.accent(mime)} ${c.muted(`(${formatBytes(data.length)})`)}`,
    );
  }
  ctx.logger.blank();
}

function serialise(metadata: TrackMetadata): Record<string, unknown> {
  const { artwork, ...rest } = metadata;
  return {
    ...rest,
    artwork:
      artwork !== undefined ? { mime: artwork.mime, bytes: artwork.data.length } : null,
  };
}

async function applyEdits(
  ctx: CliContext,
  files: readonly string[],
  options: TagOptions,
  updates: TrackMetadata,
): Promise<number> {
  const artwork = options.artwork !== undefined ? await loadArtwork(ctx, options.artwork) : undefined;

  const results = await mapPool(
    files,
    async (file) => {
      const existing = options.clear ? {} : await readTags(file);
      let metadata = options.clear ? {} : mergeMetadata(existing, updates);

      if (options.removeArtwork) delete metadata.artwork;
      if (artwork !== undefined) metadata = { ...metadata, artwork };

      await writeTags(file, metadata);
      return metadata;
    },
    { limit: 4, signal: ctx.signal },
  );

  let updated = 0;
  let failed = 0;
  results.forEach((result, index) => {
    const file = files[index] as string;
    if (result.status === 'fulfilled') {
      updated++;
      if (ctx.flags.json !== true) {
        ctx.logger.success(`${path.basename(file)} ${c.muted('updated')}`);
      }
    } else {
      failed++;
      ctx.logger.error(`${path.basename(file)}: ${errorMessage(result.reason)}`);
    }
  });

  if (ctx.flags.json === true) {
    ctx.logger.resultJson({
      updated,
      failed,
      files: results.map((result, index) => ({
        file: files[index],
        ok: result.status === 'fulfilled',
        ...(result.status === 'fulfilled' ? { tags: serialise(result.value) } : { error: errorMessage(result.reason) }),
      })),
    });
  }

  return failed > 0 ? (updated > 0 ? ExitCode.PartialFailure : ExitCode.Failure) : ExitCode.Ok;
}

async function loadArtwork(ctx: CliContext, source: string) {
  if (/^https?:\/\//i.test(source)) {
    const url = parseUrl(source, {
      allowPrivateHosts: ctx.config.allowPrivateHosts,
      allowInsecure: ctx.config.allowInsecure,
    });
    const { data } = await ctx.http.buffer(url, {
      maxBytes: 16 * 1024 * 1024,
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    return toArtwork(data);
  }
  return readArtworkFile(source);
}

async function exportArtwork(ctx: CliContext, files: readonly string[], target: string): Promise<number> {
  if (files.length !== 1) {
    throw new UsageError('--export-artwork works on one file at a time.');
  }
  const file = files[0] as string;
  const metadata = await readTags(file);

  if (metadata.artwork === undefined) {
    throw new VectraxError(`${path.basename(file)} has no embedded artwork.`, {
      code: 'E_NO_MEDIA',
      exitCode: ExitCode.NoResults,
    });
  }

  const destination =
    path.extname(target) === '' ? `${target}${artworkExtension(metadata.artwork)}` : target;

  await writeFile(destination, metadata.artwork.data);
  ctx.logger.success(
    `Artwork written to ${c.accent(destination)} ${c.muted(`(${formatBytes(metadata.artwork.data.length)})`)}`,
  );
  return ExitCode.Ok;
}

async function editInteractively(ctx: CliContext, file: string, options: TagOptions): Promise<number> {
  if (!isInteractiveSession() || ctx.flags.json === true) {
    throw new UsageError('--interactive requires a terminal.', {
      hint: 'Use --set field=value to edit non-interactively.',
    });
  }

  const original = await readTags(file);
  ctx.logger.blank();
  ctx.logger.result(c.accent(path.basename(file)));
  printTags(ctx, original, file);
  ctx.logger.detail('Enter a new value, or press enter to keep the current one. Esc cancels.');
  ctx.logger.blank();

  const edited: TrackMetadata = { ...original };

  for (const field of EDITABLE_FIELDS) {
    const current = original[field];
    const answer = await text({
      message: padEnd(FIELD_LABELS[field], 13),
      initial: current !== undefined ? String(current) : '',
      placeholder: current === undefined ? c.muted('(empty)') : '',
      flag: `--set ${field}=…`,
    });

    const trimmed = answer.trim();
    if (trimmed === '') {
      delete edited[field];
      continue;
    }
    if (NUMERIC_FIELDS.has(field)) {
      const parsed = Number.parseInt(trimmed, 10);
      if (Number.isFinite(parsed) && parsed >= 0) Object.assign(edited, { [field]: parsed });
    } else {
      Object.assign(edited, { [field]: trimmed });
    }
  }

  if (options.removeArtwork) delete edited.artwork;

  ctx.logger.blank();
  const changes = summariseChanges(original, edited);
  if (changes.length === 0) {
    ctx.logger.info('No changes.');
    return ExitCode.Ok;
  }

  ctx.logger.heading('changes');
  for (const change of changes) ctx.logger.result(`  ${change}`);
  ctx.logger.blank();

  if (!options.yes) {
    const proceed = await confirm({ message: `Write ${changes.length} change(s) to the file?`, initial: true, flag: '--yes' });
    if (!proceed) {
      ctx.logger.info('Cancelled — the file was not modified.');
      return ExitCode.Ok;
    }
  }

  await writeTags(file, edited);
  ctx.logger.success(`${path.basename(file)} updated`);
  return ExitCode.Ok;
}

function summariseChanges(before: TrackMetadata, after: TrackMetadata): string[] {
  const lines: string[] = [];
  for (const field of EDITABLE_FIELDS) {
    const from = before[field];
    const to = after[field];
    if (String(from ?? '') === String(to ?? '')) continue;

    const label = c.muted(padEnd(FIELD_LABELS[field], 13));
    const oldValue = from === undefined ? c.muted('(empty)') : c.danger(truncate(String(from), 30));
    const newValue = to === undefined ? c.muted('(cleared)') : c.success(truncate(String(to), 30));
    lines.push(`${label} ${oldValue} ${c.muted(glyph.arrow)} ${newValue}`);
  }
  return lines;
}

export const TAG_FIELDS: readonly EditableField[] = EDITABLE_FIELDS;
