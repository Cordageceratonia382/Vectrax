import { c, glyph, gradient, colorLevel, unicodeSupported } from './theme.js';
import { condense, contaminate, reagents, seedEntropy } from './chemistry.js';
import { displayWidth } from '../core/util/format.js';
import { breakpointFor, usableColumns } from './layout.js';

const WORDMARK = [
  '██╗   ██╗███████╗ ██████╗████████╗██████╗  █████╗ ██╗  ██╗',
  '██║   ██║██╔════╝██╔════╝╚══██╔══╝██╔══██╗██╔══██╗╚██╗██╔╝',
  '██║   ██║█████╗  ██║        ██║   ██████╔╝███████║ ╚███╔╝ ',
  '╚██╗ ██╔╝██╔══╝  ██║        ██║   ██╔══██╗██╔══██║ ██╔██╗ ',
  ' ╚████╔╝ ███████╗╚██████╗   ██║   ██║  ██║██║  ██║██╔╝ ██╗',
  '  ╚═══╝  ╚══════╝ ╚═════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝',
];

const WORDMARK_WIDTH = Math.max(...WORDMARK.map(displayWidth));

const LATTICE = unicodeSupported
  ? '⌬───⌬───⌬───⌬───⌬───⌬───⌬───⌬───⌬───⌬───⌬───⌬───⌬───⌬───⌬'
  : '*---*---*---*---*---*---*---*---*---*---*---*---*---*---*';

const TAGLINE = 'volatile media extraction';

export interface BannerOptions {
  version: string;
  columns?: number;
  tagline?: string;
  settle?: number;
}

export function renderBanner(options: BannerOptions): string {
  const detected = options.columns ?? usableColumns(process.stdout);
  const columns = detected > 0 ? detected : 80;
  const tagline = options.tagline ?? TAGLINE;
  const settle = options.settle ?? 1;

  if (columns < WORDMARK_WIDTH + 4) return renderCompactBanner(options.version, tagline, columns);

  const shades = gradient('#FFFFFF', '#7C3AED', WORDMARK.length);
  const indent = '  ';

  const lines = WORDMARK.map((line, index) => {
    const paint = shades[index] ?? ((text: string) => text);
    const settled = settle >= 1 ? line : condense(line, settle);
    return indent + paint(settled);
  });

  const latticeWidth = Math.min(WORDMARK_WIDTH, columns - indent.length * 2);
  const lattice = indent + c.accentDeep(LATTICE.slice(0, latticeWidth));

  const meta = [
    c.accent(`v${options.version}`),
    c.muted(reagents.bond[0] ?? '-'),
    c.muted(tagline),
  ].join(' ');

  return ['', ...lines, lattice, `${indent}${meta}`, ''].join('\n');
}

function renderCompactBanner(version: string, tagline: string, columns: number): string {
  const mark = colorLevel > 0 ? c.onAccent(` ${reagents.atom} VECTRAX `) : `[ VECTRAX ]`;
  const head = `  ${mark} ${c.accent(`v${version}`)}`;
  const room = columns - displayWidth(`  [ ${reagents.atom} VECTRAX ] v${version}  `);
  const suffix = room >= displayWidth(tagline) ? `  ${c.muted(tagline)}` : '';
  return `\n${head}${suffix}\n`;
}

export function shouldShowBanner(options: {
  json: boolean;
  quiet: boolean;
  noBanner: boolean;
  stream?: NodeJS.WriteStream;
}): boolean {
  if (options.json || options.quiet || options.noBanner) return false;
  if (process.env['VECTRAX_NO_BANNER'] !== undefined) return false;
  return (options.stream ?? process.stderr).isTTY === true;
}

const REACTION_STEPS = 7;
const REACTION_FRAME_MS = 42;

export async function playBannerReaction(
  options: BannerOptions & { stream?: NodeJS.WriteStream },
): Promise<void> {
  const stream = options.stream ?? process.stderr;
  const columns = usableColumns(stream);

  if (breakpointFor(columns) === 'micro' || process.env['VECTRAX_NO_ANIMATION'] !== undefined) {
    stream.write(`${renderBanner({ ...options, columns })}\n`);
    return;
  }

  seedEntropy(0x5eed1e);
  const settled = renderBanner({ ...options, columns });
  const height = settled.split('\n').length;

  stream.write('\u001B[?25l');
  try {
    for (let step = 0; step < REACTION_STEPS; step++) {
      stream.write(renderBanner({ ...options, columns, settle: (step + 1) / REACTION_STEPS }));
      await sleep(REACTION_FRAME_MS);
      stream.write(`\u001B[${height - 1}A\u001B[G`);
    }
  } finally {
    stream.write(`${settled}\n\u001B[?25h`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function renderCorruptedTitle(text: string, intensity: number): string {
  return c.accent(contaminate(text, intensity));
}

export const bannerGlyph = glyph;
