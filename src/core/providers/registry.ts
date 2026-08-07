import { pageProvider } from './page.js';
import { unsupportedProvider } from './unsupported.js';
import { youtubeProvider } from './youtube.js';
import type { Provider } from './types.js';

export const providers: readonly Provider[] = [youtubeProvider, unsupportedProvider, pageProvider];

export function providerFor(url: URL): Provider {
  return providers.find((provider) => provider.supports(url)) ?? pageProvider;
}

export const providerIds: readonly string[] = providers.map((provider) => provider.id);
