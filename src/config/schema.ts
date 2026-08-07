import { z } from 'zod';

import { MEDIA_KINDS } from '../core/scrape/media.js';
import { DEFAULT_USER_AGENT } from '../core/http/client.js';
import { defaultDownloadDirectory } from '../core/util/platform.js';

export const DEFAULT_OUTPUT_DIR = defaultDownloadDirectory();

export const configSchema = z.object({
  outputDir: z.string().min(1).default(DEFAULT_OUTPUT_DIR),

  concurrency: z.coerce.number().int().min(1).max(16).default(4),

  retries: z.coerce.number().int().min(0).max(10).default(3),

  timeoutMs: z.coerce.number().int().min(1_000).max(600_000).default(30_000),

  stallTimeoutMs: z.coerce.number().int().min(5_000).max(600_000).default(60_000),

  userAgent: z.string().min(1).default(DEFAULT_USER_AGENT),

  referer: z.string().default('auto'),

  kinds: z.array(z.enum(MEDIA_KINDS)).min(1).default(['audio']),

  conflict: z.enum(['rename', 'skip', 'overwrite']).default('rename'),

  resume: z.boolean().default(true),

  allowPrivateHosts: z.boolean().default(false),

  allowInsecure: z.boolean().default(true),

  fallback: z.boolean().default(true),
});

export type Config = z.infer<typeof configSchema>;
export type ConfigInput = z.input<typeof configSchema>;

export const CONFIG_KEYS = Object.keys(configSchema.shape) as (keyof Config)[];

export function envNameFor(key: keyof Config): string {
  return `VECTRAX_${key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<ConfigInput> {
  const out: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) {
    const raw = env[envNameFor(key)];
    if (raw === undefined || raw === '') continue;
    if (key === 'kinds') out[key] = raw.split(',').map((value) => value.trim()).filter(Boolean);
    else if (key === 'resume' || key === 'allowPrivateHosts' || key === 'allowInsecure') {
      out[key] = raw !== '0' && raw.toLowerCase() !== 'false';
    } else out[key] = raw;
  }
  return out as Partial<ConfigInput>;
}
