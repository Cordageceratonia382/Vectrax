import os from 'node:os';

export type ColorLevel = 0 | 1 | 2 | 3;

function windowsBuild(): number {
  const parts = os.release().split('.');
  return Number(parts[2] ?? 0);
}

function modernWindowsTerminal(): boolean {
  const env = process.env;
  return (
    env['WT_SESSION'] !== undefined ||
    env['WT_PROFILE_ID'] !== undefined ||
    env['TERM_PROGRAM'] === 'vscode' ||
    env['TERM_PROGRAM'] === 'Hyper' ||
    env['ConEmuANSI'] === 'ON' ||
    env['TERM'] !== undefined
  );
}

function detectColorLevel(stream: NodeJS.WriteStream = process.stderr): ColorLevel {
  const env = process.env;

  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return 0;
  if (env['VECTRAX_NO_COLOR'] !== undefined && env['VECTRAX_NO_COLOR'] !== '') return 0;

  const force = env['FORCE_COLOR'];
  if (force !== undefined) {
    if (force === '0' || force === 'false') return 0;
    if (force === '1' || force === 'true' || force === '') return 1;
    if (force === '2') return 2;
    if (force === '3') return 3;
  }

  if (env['TERM'] === 'dumb') return 0;
  if (!stream.isTTY) return 0;

  const colorterm = env['COLORTERM'];
  if (colorterm === 'truecolor' || colorterm === '24bit') return 3;
  if (env['TERM_PROGRAM'] === 'iTerm.app' || env['TERM_PROGRAM'] === 'WezTerm') return 3;

  if (process.platform === 'win32') {
    if (modernWindowsTerminal()) return 3;
    const build = windowsBuild();
    if (build >= 14_931) return 3;
    if (build >= 10_586) return 2;
    return 1;
  }

  if (env['TERM']?.includes('256')) return 2;
  if (env['CI'] !== undefined) return 1;

  return 1;
}

export const colorLevel: ColorLevel = detectColorLevel();

export const unicodeSupported: boolean =
  process.env['VECTRAX_ASCII'] === undefined &&
  (process.platform !== 'win32' || modernWindowsTerminal() || windowsBuild() >= 22_000);

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const hex = (value: string): Rgb => {
  const n = Number.parseInt(value.replace('#', ''), 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
};

const PALETTE = {
  violet: { rgb: hex('#A855F7'), ansi256: 141, fallback: 35 },
  violetBright: { rgb: hex('#C4A5FF'), ansi256: 183, fallback: 95 },
  violetDeep: { rgb: hex('#7C3AED'), ansi256: 99, fallback: 35 },
  white: { rgb: hex('#F8FAFC'), ansi256: 255, fallback: 97 },
  muted: { rgb: hex('#8B8FA3'), ansi256: 245, fallback: 90 },
  success: { rgb: hex('#4ADE80'), ansi256: 114, fallback: 32 },
  warn: { rgb: hex('#FBBF24'), ansi256: 221, fallback: 33 },
  danger: { rgb: hex('#F87171'), ansi256: 210, fallback: 31 },
  info: { rgb: hex('#67E8F9'), ansi256: 117, fallback: 36 },
} as const;

export type PaletteKey = keyof typeof PALETTE;

const RESET = '\u001B[0m';

function fgCode(key: PaletteKey): string {
  const entry = PALETTE[key];
  switch (colorLevel) {
    case 3:
      return `\u001B[38;2;${entry.rgb.r};${entry.rgb.g};${entry.rgb.b}m`;
    case 2:
      return `\u001B[38;5;${entry.ansi256}m`;
    case 1:
      return `\u001B[${entry.fallback}m`;
    default:
      return '';
  }
}

function bgCode(key: PaletteKey): string {
  const entry = PALETTE[key];
  switch (colorLevel) {
    case 3:
      return `\u001B[48;2;${entry.rgb.r};${entry.rgb.g};${entry.rgb.b}m`;
    case 2:
      return `\u001B[48;5;${entry.ansi256}m`;
    case 1:
      return `\u001B[${entry.fallback + 10}m`;
    default:
      return '';
  }
}

type Painter = (text: string) => string;

function makePainter(open: string): Painter {
  if (open === '') return (text) => text;
  return (text) => `${open}${text}${RESET}`;
}

function makeStyle(code: number): Painter {
  if (colorLevel === 0) return (text) => text;
  return (text) => `\u001B[${code}m${text}\u001B[0m`;
}

export const c = {
  accent: makePainter(fgCode('violet')),
  accentBright: makePainter(fgCode('violetBright')),
  accentDeep: makePainter(fgCode('violetDeep')),
  text: makePainter(fgCode('white')),
  muted: makePainter(fgCode('muted')),
  success: makePainter(fgCode('success')),
  warn: makePainter(fgCode('warn')),
  danger: makePainter(fgCode('danger')),
  info: makePainter(fgCode('info')),

  onAccent: makePainter(`${bgCode('violetDeep')}${fgCode('white')}`),
  onDanger: makePainter(`${bgCode('danger')}${fgCode('white')}`),

  bold: makeStyle(1),
  dim: makeStyle(2),
  italic: makeStyle(3),
  underline: makeStyle(4),
  inverse: makeStyle(7),
} as const;

export function gradient(from: string, to: string, steps: number): Painter[] {
  const a = hex(from);
  const b = hex(to);
  const out: Painter[] = [];
  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0 : i / (steps - 1);
    const r = Math.round(a.r + (b.r - a.r) * t);
    const g = Math.round(a.g + (b.g - a.g) * t);
    const bl = Math.round(a.b + (b.b - a.b) * t);
    if (colorLevel === 3) out.push(makePainter(`\u001B[38;2;${r};${g};${bl}m`));
    else if (colorLevel === 2) out.push(makePainter(fgCode(t < 0.5 ? 'white' : 'violet')));
    else if (colorLevel === 1) out.push(makePainter(fgCode(t < 0.5 ? 'white' : 'violet')));
    else out.push((text) => text);
  }
  return out;
}

export const glyph = unicodeSupported
  ? {
      tick: '✔',
      cross: '✖',
      warn: '▲',
      info: '›',
      bullet: '⋄',
      arrow: '→',
      pointer: '⟩',
      barFull: '▰',
      barPartial: ['', '▱', '▪', '▫'],
      barEmpty: '·',
      lineV: '│',
      cornerTop: '╭',
      cornerBottom: '╰',
      radioOn: '◉',
      radioOff: '◯',
      checkOn: '◆',
      checkOff: '◇',
      spinner: ['⬡', '⬢', '⬣', '⬢'],
      ellipsis: '…',
    }
  : {
      tick: '+',
      cross: 'x',
      warn: '!',
      info: '>',
      bullet: '*',
      arrow: '->',
      pointer: '>',
      barFull: '#',
      barPartial: [''],
      barEmpty: '.',
      lineV: '|',
      cornerTop: '+',
      cornerBottom: '+',
      radioOn: '(*)',
      radioOff: '( )',
      checkOn: '[x]',
      checkOff: '[ ]',
      spinner: ['-', '\\', '|', '/'],
      ellipsis: '...',
    };

const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

export const ansi = {
  reset: RESET,
  hideCursor: '\u001B[?25l',
  showCursor: '\u001B[?25h',
  clearLine: '\u001B[2K',
  cursorHome: '\u001B[G',
  cursorUp: (n: number) => (n > 0 ? `\u001B[${n}A` : ''),
  cursorDown: (n: number) => (n > 0 ? `\u001B[${n}B` : ''),
} as const;
