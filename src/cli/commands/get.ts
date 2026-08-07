import path from 'node:path';

import { CancelledError, ExitCode, VectraxError, errorMessage, isAbortError, isVectraxError } from '../../core/errors.js';
import { DownloadEngine } from '../../core/download/engine.js';
import type { DownloadOutcome, DownloadRequest } from '../../core/download/types.js';
import { parseUrl } from '../../core/http/guard.js';
import type { MediaIntent, QualityTargets } from '../../core/quality.js';
import {
  discoverWithFallback,
  kindsForIntent,
  noMediaError,
  probeSizes,
  type SizedCandidate,
} from '../../core/scrape/discover.js';
import { applyMetadata, type TaggingJob } from '../../core/metadata/embed.js';
import { detectFallbackTool, resetFallbackCache, runFallback, type FallbackTool } from '../../core/fallback/ytdlp.js';
import { manualInstruction, performInstall, planInstall } from '../../core/fallback/install.js';
import { convertFile, detectToolchain, ffmpegInstruction } from '../../core/convert/ffmpeg.js';
import { KEEP_ORIGINAL, targetFormatFor, type FormatChoice } from '../../core/convert/formats.js';
import { supportsTagging } from '../../core/metadata/tags.js';
import type { ResolvedMedia } from '../../core/providers/types.js';
import { describeFormat, type MediaCandidate } from '../../core/scrape/media.js';
import {
  formatBytes,
  formatDuration,
  formatPercent,
  formatRate,
  pluralize,
  renderBar,
  truncate,
} from '../../core/util/format.js';
import { ensureWritableDir, fileSize, moveFile, resolvePath, uniquePath } from '../../core/util/fs.js';
import { mapPool } from '../../core/util/pool.js';
import { DownloadDashboard } from '../../ui/progress.js';
import { LiveRegion } from '../../ui/live.js';
import { browseDirectory, confirm, isInteractiveSession, multiSelect, text } from '../../ui/prompts.js';
import { c, glyph } from '../../ui/theme.js';
import type { CliContext } from '../context.js';
import { parseSelection, resolveReferer } from '../options.js';

export interface GetOptions {
  kinds: string[] | undefined;
  extensions: string[] | undefined;
  match: RegExp | undefined;
  all: boolean;
  select: string | undefined;
  yes: boolean;
  sizes: boolean;
  dryRun: boolean;
  move: string | undefined;
  tag: boolean;
  artwork: boolean;
  media: MediaIntent;
  quality: QualityTargets;
  limit: number | undefined;
  fallback: boolean;
  installFallback: boolean;
  format: FormatChoice;
}

export async function runGet(ctx: CliContext, rawUrl: string, options: GetOptions): Promise<number> {
  const url = parseUrl(rawUrl, {
    allowPrivateHosts: ctx.config.allowPrivateHosts,
    allowInsecure: ctx.config.allowInsecure,
  });
  const kinds = (options.kinds ?? kindsForIntent(options.media, ctx.config.kinds)) as typeof ctx.config.kinds;
  const outputDir = resolvePath(ctx.config.outputDir);

  ctx.logger.step(`Resolving ${c.accent(url.host)}${c.muted(truncate(url.pathname, 48))}`);

  const discovery = await discoverWithFallback(ctx.http, url, {
    kinds,
    ...(options.extensions !== undefined ? { extensions: options.extensions } : {}),
    match: options.match,
    media: options.media,
    quality: options.quality,
    limit: options.limit,
    signal: ctx.signal,
  });

  for (const warning of discovery.warnings) ctx.logger.warn(warning);

  if (discovery.items.length === 0) throw noMediaError(discovery, kinds);

  const referer = resolveReferer(ctx.config.referer, discovery.direct ? undefined : discovery.pageUrl);

  ctx.logger.success(
    `Found ${c.bold(c.text(pluralize(discovery.items.length, 'file')))}` +
      (discovery.pageTitle !== undefined ? c.muted(` on “${truncate(discovery.pageTitle, 44)}”`) : ''),
  );

  const candidates: (ResolvedMedia | SizedCandidate)[] = options.sizes
    ? await probeSizes(ctx.http, discovery.items, {
        concurrency: ctx.config.concurrency,
        referer,
        signal: ctx.signal,
      })
    : [...discovery.items];

  const selected = await selectCandidates(ctx, candidates, options);
  if (selected.length === 0) {
    ctx.logger.warn('Nothing selected.');
    return ExitCode.NoResults;
  }

  ctx.logger.blank();
  ctx.logger.field('Files', String(selected.length));
  ctx.logger.field('Destination', outputDir);
  if (options.dryRun) ctx.logger.field('Mode', 'dry run — nothing will be written');

  if (!options.yes && !options.dryRun && isInteractiveSession() && ctx.flags.json !== true) {
    ctx.logger.blank();
    const proceed = await confirm({
      message: `Download ${pluralize(selected.length, 'file')}?`,
      initial: true,
      flag: '--yes',
    });
    if (!proceed) {
      ctx.logger.info('Cancelled.');
      return ExitCode.Ok;
    }
  }

  await ensureWritableDir(outputDir);

  const requests: DownloadRequest[] = selected.map((item, index) => ({
    id: `${index}`,
    url: item.url,
    title: item.title,
    outputDir,
    ...(item.headers !== undefined ? { headers: item.headers } : {}),
    ...(item.headers?.['referer'] === undefined && referer !== undefined ? { referer } : {}),
    ...(item.filename !== undefined ? { filename: item.filename } : {}),
    ...(item.failureHint !== undefined ? { failureHint: item.failureHint } : {}),
    ...('size' in item && item.size !== undefined ? { expectedSize: item.size } : {}),
  }));

  const dashboard = options.dryRun
    ? undefined
    : new DownloadDashboard({
        logger: ctx.logger,
        total: requests.length,
        plain: ctx.flags.json === true,
      });

  const engine = new DownloadEngine(ctx.http, {
    concurrency: ctx.config.concurrency,
    retries: ctx.config.retries,
    stallTimeoutMs: ctx.config.stallTimeoutMs,
    conflict: ctx.config.conflict,
    resume: ctx.config.resume,
    dryRun: options.dryRun,
    ...(dashboard !== undefined ? { onUpdate: (snapshot) => dashboard.handle(snapshot) } : {}),
  });

  ctx.logger.blank();
  const startedAt = Date.now();
  dashboard?.start();
  let outcomes: DownloadOutcome[];
  try {
    outcomes = await engine.run(requests, ctx.signal);
  } finally {
    dashboard?.stop();
  }
  const recovered = await recoverFailures(ctx, outcomes, selected, options);
  const converted = await convertOutputs(ctx, outcomes, selected, options);
  const elapsedMs = Date.now() - startedAt;

  const completedOutcomes = outcomes.filter((o) => o.state === 'completed');
  const tagging =
    options.tag && !options.dryRun
      ? await tagDownloads(ctx, completedOutcomes, selected, options)
      : undefined;

  const completed = outcomes.filter((o) => o.state === 'completed');
  const skipped = outcomes.filter((o) => o.state === 'skipped');
  const failed = outcomes.filter((o) => o.state === 'failed');
  const cancelled = outcomes.filter((o) => o.state === 'cancelled');

  if (ctx.flags.json === true) {
    ctx.logger.resultJson({
      url: discovery.pageUrl.href,
      outputDir,
      durationMs: elapsedMs,
      summary: {
        total: outcomes.length,
        completed: completed.length,
        skipped: skipped.length,
        failed: failed.length,
        cancelled: cancelled.length,
        bytes: completed.reduce((sum, o) => sum + o.bytes, 0),
        ...(tagging !== undefined ? { tagged: tagging.tagged } : {}),
      },
      results: outcomes.map((o) => ({
        url: o.request.url,
        title: o.request.title,
        state: o.state,
        path: o.path ?? null,
        bytes: o.bytes,
        resumed: o.resumed,
        error: o.error !== undefined ? errorMessage(o.error) : null,
      })),
    });
  } else {
    printSummary(ctx, {
      completed,
      skipped,
      failed,
      cancelled,
      elapsedMs,
      outputDir,
      dryRun: options.dryRun,
      tagging,
      recovered,
      converted,
    });
  }

  if (completed.length > 0 && !options.dryRun) {
    await maybeMove(ctx, completed, options);
  }

  if (cancelled.length > 0) return ExitCode.Interrupted;
  if (failed.length > 0) return completed.length > 0 ? ExitCode.PartialFailure : ExitCode.NetworkError;
  return ExitCode.Ok;
}

async function selectCandidates(
  ctx: CliContext,
  candidates: readonly (ResolvedMedia | SizedCandidate)[],
  options: GetOptions,
): Promise<(ResolvedMedia | SizedCandidate)[]> {
  if (options.select !== undefined) {
    return parseSelection(options.select, candidates.length).map(
      (index) => candidates[index] as MediaCandidate,
    );
  }
  if (options.all || candidates.length === 1) return [...candidates];

  if (!isInteractiveSession() || ctx.flags.json === true) {
    throw new VectraxError(`Found ${candidates.length} files but no selection was given.`, {
      code: 'E_USAGE',
      exitCode: ExitCode.UsageError,
      hint: 'Pass --all to take everything, or --select 1,3,5-8 to choose.',
    });
  }

  ctx.logger.blank();
  return multiSelect({
    message: 'Select files to download',
    required: true,
    flag: '--all or --select',
    items: candidates.map((item) => ({
      value: item,
      label: item.title,
      hint: [describeFormat(item), 'size' in item && item.size !== undefined ? formatBytes(item.size) : undefined]
        .filter((v): v is string => v !== undefined && v !== '')
        .join('  '),
    })),
  });
}

function printSummary(
  ctx: CliContext,
  data: {
    completed: DownloadOutcome[];
    skipped: DownloadOutcome[];
    failed: DownloadOutcome[];
    cancelled: DownloadOutcome[];
    elapsedMs: number;
    outputDir: string;
    dryRun: boolean;
    tagging: { tagged: number; skipped: number; warnings: readonly string[] } | undefined;
    recovered: Recovery | undefined;
    converted: number;
  },
): void {
  const bytes = data.completed.reduce((sum, o) => sum + o.bytes, 0);
  const resumed = data.completed.filter((o) => o.resumed).length;

  ctx.logger.heading(data.dryRun ? 'dry run' : 'summary');

  if (data.dryRun) {
    ctx.logger.success(
      `${pluralize(data.completed.length, 'file')} would be downloaded ${c.muted(`(~${formatBytes(bytes)})`)}`,
    );
    for (const outcome of data.completed) {
      const name = outcome.path !== undefined ? path.basename(outcome.path) : outcome.request.title;
      ctx.logger.detail(`${c.muted(glyph.arrow)} ${truncate(name, ctx.logger.columns - 6)}`);
    }
    return;
  }

  if (data.completed.length > 0) {
    ctx.logger.success(
      `${pluralize(data.completed.length, 'file')} downloaded ${c.muted(
        `(${formatBytes(bytes)} in ${formatDuration(data.elapsedMs)} @ ${formatRate((bytes / Math.max(1, data.elapsedMs)) * 1000)})`,
      )}`,
    );
  }
  if (resumed > 0) ctx.logger.detail(`${resumed} resumed from a previous run`);
  if (data.converted > 0) {
    ctx.logger.detail(`${pluralize(data.converted, 'file')} converted`);
  }
  if (data.recovered !== undefined) {
    ctx.logger.detail(
      `${pluralize(data.recovered.count, 'file')} recovered via ${path.basename(data.recovered.tool.binary)}`,
    );
  }
  if (data.tagging !== undefined && data.tagging.tagged > 0) {
    ctx.logger.detail(`${pluralize(data.tagging.tagged, 'file')} tagged with metadata`);
  }
  for (const warning of data.tagging?.warnings ?? []) {
    ctx.logger.detail(`${c.warn(glyph.warn)} could not tag ${warning}`);
  }
  if (data.skipped.length > 0) {
    ctx.logger.info(`${pluralize(data.skipped.length, 'file')} skipped ${c.muted('(already present)')}`);
  }
  if (data.cancelled.length > 0) {
    ctx.logger.warn(`${pluralize(data.cancelled.length, 'file')} cancelled ${c.muted('(re-run to resume)')}`);
  }

  if (data.failed.length > 0) {
    ctx.logger.error(`${pluralize(data.failed.length, 'file')} failed`);
    const seenHints = new Set<string>();
    for (const outcome of data.failed) {
      ctx.logger.detail(
        `${c.danger(glyph.cross)} ${truncate(outcome.request.title, 44)} ${c.muted(`— ${errorMessage(outcome.error)}`)}`,
      );
      const hint = isVectraxError(outcome.error) ? outcome.error.hint : undefined;
      if (hint !== undefined && !seenHints.has(hint)) {
        seenHints.add(hint);
        ctx.logger.detail(`  ${c.muted(hint)}`);
      }
    }
  }

  if (data.completed.length > 0) {
    ctx.logger.blank();
    ctx.logger.field('Saved to', data.outputDir);
  }
}

async function maybeMove(ctx: CliContext, completed: DownloadOutcome[], options: GetOptions): Promise<void> {
  let target = options.move !== undefined ? resolvePath(options.move) : undefined;

  if (target === undefined) {
    if (options.yes || !isInteractiveSession() || ctx.flags.json === true) return;
    ctx.logger.blank();
    const wants = await confirm({ message: 'Move these files somewhere else?', initial: false, flag: '--move' });
    if (!wants) return;
    target = await promptForDirectory(ctx);
    if (target === undefined) return;
  }

  await ensureWritableDir(target);
  ctx.logger.blank();
  ctx.logger.step(`Moving ${pluralize(completed.length, 'file')} to ${c.accent(target)}`);

  const results = await mapPool(
    completed,
    async (outcome) => {
      const source = outcome.path as string;
      const destination = await uniquePath(target as string, path.basename(source));
      await moveFile(source, destination);
      return destination;
    },
    { limit: 1, signal: ctx.signal },
  );

  const moved = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.length - moved;

  if (moved > 0) ctx.logger.success(`${pluralize(moved, 'file')} moved`);
  if (failed > 0) {
    ctx.logger.error(`${pluralize(failed, 'file')} could not be moved`);
    for (const result of results) {
      if (result.status === 'rejected') ctx.logger.detail(errorMessage(result.reason));
    }
  }
}

async function promptForDirectory(ctx: CliContext): Promise<string | undefined> {
  try {
    const answer = await text({
      message: 'Destination',
      placeholder: 'type a path, or leave empty to browse',
      hint: 'enter accepts • esc cancels',
      flag: '--move <dir>',
    });
    if (answer.trim() === '') return await browseDirectory({ message: 'Choose a destination folder' });
    return resolvePath(answer);
  } catch (error) {
    if (isAbortError(error) || error instanceof CancelledError) {
      ctx.logger.info('Move cancelled — files remain in the download directory.');
      return undefined;
    }
    throw error;
  }
}

async function tagDownloads(
  ctx: CliContext,
  completed: readonly DownloadOutcome[],
  selected: readonly (ResolvedMedia | SizedCandidate)[],
  options: GetOptions,
): Promise<{ tagged: number; skipped: number; warnings: readonly string[] } | undefined> {
  const jobs: TaggingJob[] = [];

  for (const outcome of completed) {
    if (outcome.path === undefined || !supportsTagging(outcome.path)) continue;
    const candidate = selected[Number(outcome.request.id)] as ResolvedMedia | undefined;
    const metadata = candidate?.metadata;
    if (metadata === undefined) continue;

    jobs.push({
      path: outcome.path,
      metadata,
      ...(options.artwork && candidate?.artworkUrl !== undefined
        ? { artworkUrl: candidate.artworkUrl }
        : {}),
    });
  }

  if (jobs.length === 0) return undefined;

  const report = await applyMetadata(ctx.http, jobs, {
    artwork: options.artwork,
    concurrency: ctx.config.concurrency,
    signal: ctx.signal,
  });

  ctx.logger.debug(`tagged ${report.tagged}/${jobs.length} files`);
  return report;
}

interface Recovery {
  readonly tool: FallbackTool;
  readonly count: number;
}

function fallbackTargetFor(
  outcome: DownloadOutcome,
  selected: readonly (ResolvedMedia | SizedCandidate)[],
): ResolvedMedia | undefined {
  if (outcome.state !== 'failed') return undefined;
  const candidate = selected[Number(outcome.request.id)] as ResolvedMedia | undefined;
  return candidate?.fallbackUrl !== undefined ? candidate : undefined;
}

async function recoverFailures(
  ctx: CliContext,
  outcomes: DownloadOutcome[],
  selected: readonly (ResolvedMedia | SizedCandidate)[],
  options: GetOptions,
): Promise<Recovery | undefined> {
  if (!options.fallback || options.dryRun) return undefined;

  const targets = outcomes
    .map((outcome, index) => ({ outcome, index, candidate: fallbackTargetFor(outcome, selected) }))
    .filter((entry) => entry.candidate !== undefined);
  if (targets.length === 0) return undefined;

  const tool = (await detectFallbackTool()) ?? (await offerInstall(ctx, targets.length, options));
  if (tool === undefined) return undefined;

  ctx.logger.blank();
  ctx.logger.step(
    `Retrying ${pluralize(targets.length, 'item')} with ${c.accent(path.basename(tool.binary))} ${c.muted(tool.version)}`,
  );

  let recoveredCount = 0;

  for (const { outcome, index, candidate } of targets) {
    const media = candidate as ResolvedMedia;
    const label = truncate(media.title, Math.max(16, ctx.logger.columns - 24));
    try {
      const result = await runFallback(tool, {
        url: media.fallbackUrl as string,
        outputDir: outcome.request.outputDir,
        filename: media.filename ?? media.title,
        media: options.media,
        quality: options.quality,
        signal: ctx.signal,
        onRetry: () => ctx.logger.detail(`${label} ${c.muted('retrying without format constraints')}`),
      });

      outcomes[index] = {
        ...outcome,
        state: 'completed',
        path: result.path,
        bytes: await fileSize(result.path),
        error: undefined,
      };
      recoveredCount++;
      ctx.logger.success(`${label} ${c.muted('recovered')}`);
    } catch (error) {
      if (isAbortError(error)) throw error;

      const reason = isVectraxError(error) ? (error.hint ?? error.message) : errorMessage(error);
      ctx.logger.error(`${label} ${c.muted(`— ${reason}`)}`);

      outcomes[index] = {
        ...outcome,
        error: new VectraxError(`${path.basename(tool.binary)} could not download this item.`, {
          code: 'E_NO_MEDIA',
          hint: reason,
        }),
      };
    }
  }

  return recoveredCount > 0 ? { tool, count: recoveredCount } : undefined;
}

async function offerInstall(
  ctx: CliContext,
  pending: number,
  options: GetOptions,
): Promise<FallbackTool | undefined> {
  const plan = await planInstall();

  if (plan === undefined) {
    ctx.logger.blank();
    ctx.logger.warn('yt-dlp is needed to finish this download, and Vectrax cannot install it here.');
    ctx.logger.detail(`Install it manually: ${c.accent(manualInstruction())}`);
    return undefined;
  }

  ctx.logger.blank();
  ctx.logger.warn(
    `yt-dlp is required to finish ${pluralize(pending, 'item')}, and it is not installed.`,
  );
  ctx.logger.detail(`Vectrax would ${plan.description}.`);

  if (!(await confirmInstall(ctx, options))) {
    ctx.logger.detail(`Install it yourself with: ${c.accent(plan.manual)}`);
    return undefined;
  }

  const region = new LiveRegion({ stream: ctx.logger.stderr, frameIntervalMs: 120 });
  if (ctx.logger.isInteractive) region.start();

  try {
    await performInstall(ctx.http, plan, {
      signal: ctx.signal,
      onStep: (message) => {
        region.update([`  ${c.muted(message)}`]);
        if (!ctx.logger.isInteractive) ctx.logger.detail(message);
      },
      onProgress: (ratio) => {
        const width = Math.max(8, Math.min(24, ctx.logger.columns - 32));
        region.update([
          `  ${c.accent(renderBar(ratio, width, { full: glyph.barFull, partial: glyph.barPartial, empty: glyph.barEmpty }))} ${c.text(formatPercent(ratio))} ${c.muted('installing yt-dlp')}`,
        ]);
      },
    });
    region.stop(false);
  } catch (error) {
    region.stop(false);
    if (isAbortError(error)) throw error;
    ctx.logger.blank();
    ctx.logger.error(`Could not install yt-dlp: ${errorMessage(error)}`);
    const hint = isVectraxError(error) ? error.hint : undefined;
    if (hint !== undefined) ctx.logger.detail(hint);
    ctx.logger.detail(`Install it manually and re-run: ${c.accent(plan.manual)}`);
    return undefined;
  }

  resetFallbackCache();
  const installed = await detectFallbackTool();
  if (installed === undefined) {
    ctx.logger.error('yt-dlp reported success but could not be run afterwards.');
    ctx.logger.detail(`Install it manually and re-run: ${c.accent(plan.manual)}`);
    return undefined;
  }

  ctx.logger.success(`yt-dlp ${installed.version} installed`);
  return installed;
}

async function confirmInstall(ctx: CliContext, options: GetOptions): Promise<boolean> {
  if (options.installFallback) return true;

  if (!isInteractiveSession() || ctx.flags.json === true) {
    ctx.logger.detail('Re-run with --install-fallback to allow this without a prompt.');
    return false;
  }

  return confirm({
    message: 'Install yt-dlp now?',
    initial: true,
    flag: '--install-fallback',
  });
}

async function convertOutputs(
  ctx: CliContext,
  outcomes: DownloadOutcome[],
  selected: readonly (ResolvedMedia | SizedCandidate)[],
  options: GetOptions,
): Promise<number> {
  if (options.format === KEEP_ORIGINAL || options.dryRun) return 0;

  const pending = outcomes
    .map((outcome, index) => ({ outcome, index }))
    .filter((entry) => entry.outcome.state === 'completed' && entry.outcome.path !== undefined);
  if (pending.length === 0) return 0;

  const tools = await detectToolchain();
  if (tools === undefined) {
    ctx.logger.blank();
    ctx.logger.warn('Format conversion needs ffmpeg, which is not installed.');
    ctx.logger.detail(`Install it with ${c.accent(ffmpegInstruction())}. Files were kept as downloaded.`);
    return 0;
  }

  let converted = 0;
  const warned = new Set<string>();

  for (const { outcome, index } of pending) {
    const source = outcome.path as string;
    const probeExtension = path.extname(source).slice(1).toLowerCase();
    const target = targetFormatFor(options.format, {
      extension: probeExtension,
      audioCodec: undefined,
      videoCodec: /^(mp4|mkv|webm|m4v|mov|avi)$/.test(probeExtension) ? 'unknown' : undefined,
      audioBitrate: undefined,
    });
    if (target === undefined) continue;

    try {
      const candidate = selected[Number(outcome.request.id)] as ResolvedMedia | undefined;
      const result = await convertFile(tools, source, target, {
        signal: ctx.signal,
        ...(candidate?.metadata !== undefined ? { metadata: candidate.metadata } : {}),
      });
      if (result.action === 'none') continue;

      outcomes[index] = { ...outcome, path: result.path };
      converted++;

      if (result.warning !== undefined && !warned.has(result.warning)) {
        warned.add(result.warning);
        ctx.logger.detail(`${c.warn(glyph.warn)} ${result.warning}`);
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      ctx.logger.error(`Could not convert ${path.basename(source)}: ${errorMessage(error)}`);
    }
  }

  return converted;
}
