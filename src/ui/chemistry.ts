import { unicodeSupported } from './theme.js';

export const reagents = unicodeSupported
  ? {
      vapour: ['·', '˙', '∘', '°', '⁘', '⁙'],
      residue: ['░', '▒', '▓'],
      bond: ['─', '═', '╌', '┄'],
      nucleus: ['◌', '◍', '◎', '●', '◉', '⬤'],
      drift: ['⋅', '∙', '•', '∘', '○'],
      unstable: ['#', '%', '&', '@', '§', '¤', '×', '≠', '∆', '∇', '≈', '∴', '⌁', '⌇'],
      flask: '⧗',
      atom: '⌬',
      spark: '✦',
    }
  : {
      vapour: ['.', "'", '`', '"'],
      residue: ['.', ':', '#'],
      bond: ['-', '=', '~'],
      nucleus: ['.', 'o', 'O', '0', '@'],
      drift: ['.', ':', '*', 'o'],
      unstable: ['#', '%', '&', '@', '$', '*', 'x', '?', '!', '/'],
      flask: 'Y',
      atom: '*',
      spark: '+',
    };

export const REACTION_SPINNER = unicodeSupported
  ? ['⌬', '⬡', '⬢', '⬣', '⬢', '⬡']
  : ['-', '\\', '|', '/'];

export const BOND_PARTIAL = unicodeSupported
  ? ['', '╴', '╌', '┄', '─', '━', '═']
  : ['', '-', '='];

let entropy = 0x9e3779b9;

function nextRandom(): number {
  entropy ^= entropy << 13;
  entropy ^= entropy >>> 17;
  entropy ^= entropy << 5;
  return ((entropy >>> 0) % 100_000) / 100_000;
}

export function seedEntropy(seed: number): void {
  entropy = seed === 0 ? 0x9e3779b9 : seed >>> 0;
}

export function contaminate(text: string, intensity: number): string {
  if (intensity <= 0) return text;
  const glyphs = reagents.unstable;

  return [...text]
    .map((char) => {
      if (char === ' ') return char;
      if (nextRandom() > intensity) return char;
      return glyphs[Math.floor(nextRandom() * glyphs.length)] ?? char;
    })
    .join('');
}

export function condense(text: string, progress: number): string {
  if (progress >= 1) return text;
  const settled = Math.max(0, Math.min(1, progress));
  const vapour = reagents.vapour;

  return [...text]
    .map((char) => {
      if (char === ' ') return char;
      if (nextRandom() <= settled) return char;
      return vapour[Math.floor(nextRandom() * vapour.length)] ?? char;
    })
    .join('');
}

export function driftField(width: number, phase: number, density = 0.12): string {
  const glyphs = reagents.drift;
  let out = '';
  for (let column = 0; column < width; column++) {
    const wave = Math.sin((column * 0.45 + phase * 0.6) * 0.7);
    const active = (wave + 1) / 2 > 1 - density;
    out += active ? (glyphs[(column + phase) % glyphs.length] ?? ' ') : ' ';
  }
  return out;
}

export function reactionEdge(phase: number): string {
  const frames = reagents.residue;
  return frames[phase % frames.length] ?? '';
}
