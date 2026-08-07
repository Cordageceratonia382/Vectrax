import path from 'node:path';

import { normalizeUrl } from '../http/guard.js';
import { detectQuality, kindForExtension, type MediaCandidate, type MediaSource } from './media.js';

export interface ExtractOptions {
  baseUrl: URL;
  extensions: readonly string[];
  match?: RegExp | undefined;
}

export interface ExtractResult {
  readonly pageTitle: string | undefined;
  readonly items: readonly MediaCandidate[];
  readonly likelyDynamic: boolean;
}

interface RawCandidate {
  href: string;
  title: string | undefined;
  source: MediaSource;
  titleRank: number;
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  bull: '•',
  middot: '·',
  times: '×',
  divide: '÷',
  deg: '°',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  dagger: '†',
  prime: '′',
  Prime: '″',
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, entity: string) => {
    const known = HTML_ENTITIES[entity] ?? HTML_ENTITIES[entity.toLowerCase()];
    if (known !== undefined) return known;
    if (entity.startsWith('#')) {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const code = Number.parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
    }
    return whole;
  });
}

function unescapeJsonish(value: string): string {
  return value
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"');
}

function textContent(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function extensionOf(url: URL): string | undefined {
  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {}
  const ext = path.extname(pathname).slice(1).toLowerCase();
  return ext === '' ? undefined : ext;
}

function resolve(href: string, base: URL): URL | undefined {
  const value = unescapeJsonish(decodeEntities(href)).trim();
  if (value === '' || value.startsWith('#')) return undefined;
  if (/^(javascript|data|mailto|tel|blob):/i.test(value)) return undefined;
  try {
    const url = new URL(value, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

function resolveBase(html: string, documentUrl: URL): URL {
  const match = /<base[^>]+href=["']([^"']+)["']/i.exec(html);
  if (match?.[1] === undefined) return documentUrl;
  try {
    return new URL(decodeEntities(match[1]), documentUrl);
  } catch {
    return documentUrl;
  }
}

export function extractPageTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match?.[1] !== undefined ? textContent(match[1]) : '';
  return title === '' ? undefined : title;
}

const MEDIA_ATTRIBUTES = [
  'src',
  'data-src',
  'data-url',
  'data-file',
  'data-mp3',
  'data-audio',
  'data-video',
  'data-track',
  'data-download',
  'content',
];

const JSON_KEYS = ['file', 'url', 'src', 'source', 'mp3', 'audio', 'stream', 'download', 'link', 'path'];

export function extractMedia(html: string, options: ExtractOptions): ExtractResult {
  const base = resolveBase(html, options.baseUrl);
  const accepted = new Set(options.extensions.map((e) => e.replace(/^\./, '').toLowerCase()));
  const raw: RawCandidate[] = [];

  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorRe)) {
    const attributes = match[1] ?? '';
    const href = attribute(attributes, 'href');
    if (href === undefined) continue;
    const text = textContent(match[2] ?? '');
    const title =
      firstNonEmpty(text, attribute(attributes, 'download'), attribute(attributes, 'title'), attribute(attributes, 'aria-label'));
    raw.push({ href, title, source: 'anchor', titleRank: text !== '' ? 4 : 3 });
  }

  for (const match of html.matchAll(/<link\b([^>]*)>/gi)) {
    const href = attribute(match[1] ?? '', 'href');
    if (href !== undefined) raw.push({ href, title: undefined, source: 'anchor', titleRank: 1 });
  }

  const tagRe = /<(?:audio|video|source|embed|iframe|meta|div|li|span|button)\b([^>]*)>/gi;
  for (const match of html.matchAll(tagRe)) {
    const attributes = match[1] ?? '';
    const title = firstNonEmpty(
      attribute(attributes, 'data-title'),
      attribute(attributes, 'data-name'),
      attribute(attributes, 'title'),
      attribute(attributes, 'aria-label'),
      attribute(attributes, 'alt'),
    );
    for (const name of MEDIA_ATTRIBUTES) {
      const value = attribute(attributes, name);
      if (value !== undefined) {
        raw.push({ href: value, title, source: 'media-tag', titleRank: title !== undefined ? 3 : 1 });
      }
    }
  }

  const jsonRe = new RegExp(`["'](?:${JSON_KEYS.join('|')})["']\\s*:\\s*["']([^"']{4,2048})["']`, 'gi');
  for (const match of html.matchAll(jsonRe)) {
    const value = match[1];
    if (value !== undefined) raw.push({ href: value, title: undefined, source: 'embedded-json', titleRank: 1 });
  }

  for (const match of html.matchAll(/https?:\/\/[^\s"'<>()\\[\]{}]+/gi)) {
    const value = match[0].replace(/[.,;:!?]+$/, '');
    raw.push({ href: value, title: undefined, source: 'raw-scan', titleRank: 0 });
  }

  const merged = new Map<string, MediaCandidate & { titleRank: number }>();

  for (const entry of raw) {
    const url = resolve(entry.href, base);
    if (url === undefined) continue;

    const extension = extensionOf(url);
    if (extension === undefined || !accepted.has(extension)) continue;

    const key = normalizeUrl(url);
    const cleanTitle = entry.title !== undefined ? tidyTitle(entry.title) : undefined;
    const title = cleanTitle ?? titleFromPath(url) ?? extractPageTitle(html) ?? 'download';

    if (options.match !== undefined && !options.match.test(key) && !options.match.test(title)) continue;

    const candidate = {
      url: key,
      title,
      kind: kindForExtension(extension),
      extension,
      quality: detectQuality(cleanTitle, url.pathname, url.search),
      source: entry.source,
      titleRank: cleanTitle !== undefined ? entry.titleRank : 0,
    };

    const existing = merged.get(key);
    if (existing === undefined || candidate.titleRank > existing.titleRank) {
      merged.set(key, existing === undefined ? candidate : { ...existing, ...candidate });
    }
  }

  const items = [...merged.values()].map(({ titleRank: _titleRank, ...item }) => item);

  return {
    pageTitle: extractPageTitle(html),
    items,
    likelyDynamic: items.length === 0 && looksDynamic(html),
  };
}

function attribute(attributes: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const match = re.exec(attributes);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function tidyTitle(value: string): string | undefined {
  const clean = decodeEntities(value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s|·•\-–—]+|[\s|·•\-–—]+$/g, '')
    .trim();
  if (clean.length < 2 || clean.length > 200) return undefined;
  if (/^(download|دانلود|link|here|click|play|listen)$/i.test(clean)) return undefined;
  return clean;
}

function titleFromPath(url: URL): string | undefined {
  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {}
  const segment = pathname.split('/').filter(Boolean).pop();
  if (segment === undefined) return undefined;
  const stem = path.basename(segment, path.extname(segment)).replace(/[_+]+/g, ' ').replace(/\s+/g, ' ').trim();
  return stem.length >= 2 ? stem : undefined;
}

function looksDynamic(html: string): boolean {
  const scriptBytes = [...html.matchAll(/<script\b[\s\S]*?<\/script>/gi)].reduce((n, m) => n + m[0].length, 0);
  const hasAppRoot = /<div[^>]+id=["'](root|app|__next|__nuxt)["']/i.test(html);
  return hasAppRoot || scriptBytes > html.length * 0.4;
}
