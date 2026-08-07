import { ExitCode } from '../../core/errors.js';
import { parseUrl } from '../../core/http/guard.js';
import type { MediaIntent, QualityTargets } from '../../core/quality.js';
import {
  discoverWithFallback,
  kindsForIntent,
  noMediaError,
  probeSizes,
  type SizedCandidate,
} from '../../core/scrape/discover.js';
import { describeFormat } from '../../core/scrape/media.js';
import type { ResolvedMedia } from '../../core/providers/types.js';
import { displayWidth, formatBytes, truncate } from '../../core/util/format.js';
import { breakpointFor, fit, wrap } from '../../ui/layout.js';
import { c, glyph } from '../../ui/theme.js';
import type { CliContext } from '../context.js';
import { resolveReferer } from '../options.js';

export interface ScanOptions {
  kinds: string[] | undefined;
  extensions: string[] | undefined;
  match: RegExp | undefined;
  sizes: boolean;
  media: MediaIntent;
  quality: QualityTargets;
  limit: number | undefined;
}

export async function runScan(ctx: CliContext, rawUrl: string, options: ScanOptions): Promise<number> {
  const url = parseUrl(rawUrl, {
    allowPrivateHosts: ctx.config.allowPrivateHosts,
    allowInsecure: ctx.config.allowInsecure,
  });

  const kinds = (options.kinds ?? kindsForIntent(options.media, ctx.config.kinds)) as typeof ctx.config.kinds;

  ctx.logger.step(`Scanning ${c.accent(url.host)}${c.muted(truncate(url.pathname, 48))}`);

  const result = await discoverWithFallback(ctx.http, url, {
    kinds,
    ...(options.extensions !== undefined ? { extensions: options.extensions } : {}),
    match: options.match,
    media: options.media,
    quality: options.quality,
    limit: options.limit,
    signal: ctx.signal,
  });

  for (const warning of result.warnings) ctx.logger.warn(warning);

  if (result.items.length === 0) throw noMediaError(result, kinds);

  const items: (ResolvedMedia | SizedCandidate)[] = options.sizes
    ? await probeSizes(ctx.http, result.items, {
        concurrency: ctx.config.concurrency,
        referer: resolveReferer(ctx.config.referer, result.direct ? undefined : result.pageUrl),
        signal: ctx.signal,
      })
    : [...result.items];

  if (ctx.flags.json === true) {
    ctx.logger.resultJson({
      url: result.pageUrl.href,
      title: result.pageTitle ?? null,
      provider: result.provider,
      direct: result.direct,
      count: items.length,
      ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
      items: items.map((item) => ({
        url: item.url,
        title: item.title,
        kind: item.kind,
        extension: item.extension ?? null,
        quality: item.quality ?? null,
        source: item.source,
        size: 'size' in item ? (item.size ?? null) : null,
        ...(item.durationSeconds !== undefined ? { durationSeconds: item.durationSeconds } : {}),
        ...(item.metadata !== undefined ? { metadata: item.metadata } : {}),
      })),
    });
    return ExitCode.Ok;
  }

  renderTable(ctx, items, result.pageTitle);
  return ExitCode.Ok;
}

export function renderTable(
  ctx: CliContext,
  items: readonly (ResolvedMedia | SizedCandidate)[],
  pageTitle: string | undefined,
): void {
  const columns = ctx.logger.columns;
  const size = breakpointFor(columns);

  if (pageTitle !== undefined) {
    ctx.logger.blank();
    for (const line of wrap(pageTitle, columns - 4)) ctx.logger.detail(line);
  }
  ctx.logger.blank();

  const indexWidth = String(items.length).length;
  const sizes = items.map((item) =>
    'size' in item && item.size !== undefined ? formatBytes(item.size) : '',
  );
  const tags = items.map((item) => describeFormat(item));

  const showSize = size !== 'micro' && sizes.some((value) => value !== '');
  const showTag = size !== 'micro' && tags.some((value) => value !== '');
  const sizeWidth = showSize ? Math.max(...sizes.map(displayWidth)) : 0;
  const tagWidth = showTag ? Math.max(...tags.map(displayWidth)) : 0;

  const reserved = indexWidth + sizeWidth + tagWidth + (showSize ? 2 : 0) + (showTag ? 2 : 0) + 4;
  const titleWidth = Math.max(12, columns - reserved);

  items.forEach((item, index) => {
    const number = c.muted(String(index + 1).padStart(indexWidth));
    const cells = [`  ${number}  ${c.text(fit(item.title, titleWidth))}`];
    if (showTag) cells.push(c.accent(fit(tags[index] ?? '', tagWidth)));
    if (showSize) cells.push(c.muted(fit(sizes[index] ?? '', sizeWidth)));
    ctx.logger.result(cells.join('  ').trimEnd());
  });

  ctx.logger.blank();
  ctx.logger.detail(
    `${items.length} item${items.length === 1 ? '' : 's'}  ${glyph.bullet}  download with: vectrax <url>`,
  );
}
