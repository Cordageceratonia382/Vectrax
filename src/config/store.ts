import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { ConfigError } from '../core/errors.js';
import { ensureDir, pathExists } from '../core/util/fs.js';
import { configDirectory } from '../core/util/platform.js';
import { configFromEnv, configSchema, type Config, type ConfigInput } from './schema.js';

export function configFilePath(): string {
  return path.join(configDirectory(), 'config.json');
}

export async function readConfigFile(file = configFilePath()): Promise<Partial<ConfigInput>> {
  if (!(await pathExists(file))) return {};
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    throw new ConfigError(`Cannot read config file: ${file}`, { cause: error });
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }
    return parsed as Partial<ConfigInput>;
  } catch (error) {
    throw new ConfigError(`Config file is not valid JSON: ${file}`, {
      hint: 'Fix the syntax, or delete the file to start from defaults.',
      cause: error,
    });
  }
}

export async function writeConfigFile(values: Partial<ConfigInput>, file = configFilePath()): Promise<void> {
  await ensureDir(path.dirname(file));
  await writeFile(file, `${JSON.stringify(values, null, 2)}\n`, 'utf8');
}

export interface ResolveConfigOptions {
  overrides?: Partial<ConfigInput>;
  file?: string;
  env?: NodeJS.ProcessEnv;
}

export async function resolveConfig(options: ResolveConfigOptions = {}): Promise<Config> {
  const fileValues = await readConfigFile(options.file ?? configFilePath());
  const merged = {
    ...compact(fileValues),
    ...compact(configFromEnv(options.env)),
    ...compact(options.overrides ?? {}),
  };
  return parseConfig(merged);
}

export function parseConfig(values: Partial<ConfigInput>): Config {
  const result = configSchema.safeParse(values);
  if (result.success) return result.data;
  throw new ConfigError(`Invalid configuration:\n${formatIssues(result.error)}`, {
    hint: 'Run `vectrax config list` to see the current values.',
  });
}

export function parseConfigValue(key: string, value: string): unknown {
  const shape = configSchema.shape as Record<string, z.ZodTypeAny>;
  const field = shape[key];
  if (field === undefined) {
    throw new ConfigError(`Unknown config key "${key}".`, {
      hint: 'Run `vectrax config list` to see available keys.',
    });
  }

  let candidate: unknown = value;
  if (key === 'kinds') candidate = value.split(',').map((v) => v.trim()).filter(Boolean);
  else if (key === 'resume' || key === 'allowPrivateHosts' || key === 'allowInsecure') {
    candidate = value !== '0' && value.toLowerCase() !== 'false';
  }

  const result = field.safeParse(candidate);
  if (!result.success) {
    throw new ConfigError(`Invalid value for "${key}": ${formatIssues(result.error)}`);
  }
  return result.data;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const field = issue.path.join('.');
      return field === '' ? issue.message : `  ${field}: ${issue.message}`;
    })
    .join('\n');
}

function compact<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
