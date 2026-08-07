import { normalizeUrl } from '../http/guard.js';
import { extractMedia } from '../scrape/extract.js';
import {
  detectQuality,
  extensionsForKinds,
  kindForExtension,
  type MediaCandidate,
} from '../scrape/media.js';
import type { Provider, ProviderContext, ProviderResult, ResolvedMedia } from './types.js';

const TEXTUAL = /^(text\/|application\/(xhtml|xml|json))/i;

export const pageProvider: Provider = {
  id: 'page',
  label: 'web page',

  supports(): boolean {
    return true;
  },

  async resolve(target: URL, context: ProviderContext): Promise<ProviderResult> {
    const accepted = [
      ...new Set([...extensionsForKinds(context.kinds), ...(context.extensions ?? [])]),
    ];
    const acceptedSet = new Set(accepted);

    const urlExtension = target.pathname.split('.').pop()?.toLowerCase();
    if (urlExtension !== undefined && acceptedSet.has(urlExtension)) {
      return { pageUrl: target, items: [directCandidate(target)], direct: true };
    }

    const probe = await context.http.probe(target, {
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
    });
    if (probe.contentType !== null && !TEXTUAL.test(probe.contentType)) {
      return { pageUrl: probe.url, items: [directCandidate(probe.url)], direct: true };
    }

    const { body, url } = await context.http.text(target, {
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
    });

    const extracted = extractMedia(body, {
      baseUrl: url,
      extensions: accepted,
      match: context.match,
    });

    return {
      pageUrl: url,
      title: extracted.pageTitle,
      items: extracted.items,
      direct: false,
      likelyDynamic: extracted.likelyDynamic,
    };
  },
};

function directCandidate(url: URL): ResolvedMedia {
  const segment = decodeSafe(url.pathname.split('/').filter(Boolean).pop() ?? 'download');
  const extension = segment.includes('.') ? segment.split('.').pop()?.toLowerCase() : undefined;
  const title = segment.replace(/\.[^.]+$/, '').replace(/[_+]+/g, ' ').trim();

  const candidate: MediaCandidate = {
    url: normalizeUrl(url),
    title: title === '' ? 'download' : title,
    kind: kindForExtension(extension),
    extension,
    quality: detectQuality(title, url.pathname),
    source: 'direct',
  };
  return candidate;
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
