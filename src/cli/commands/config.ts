import { ExitCode, ConfigError } from '../../core/errors.js';
import {
  CONFIG_KEYS,
  configFromEnv,
  envNameFor,
  type Config,
  type ConfigInput,
} from '../../config/schema.js';
import { configFilePath, parseConfigValue, readConfigFile, resolveConfig, writeConfigFile } from '../../config/store.js';
import { padEnd, truncate } from '../../core/util/format.js';
import { c, glyph } from '../../ui/theme.js';
import type { CliContext } from '../context.js';

type Origin = 'default' | 'file' | 'env';

export async function runConfigList(ctx: CliContext): Promise<number> {
  const file = configFilePath();
  const fileValues = await readConfigFile(file);
  const envValues = configFromEnv();
  const effective = await resolveConfig();

  if (ctx.flags.json === true) {
    ctx.logger.resultJson({ file, effective, sources: originMap(fileValues, envValues) });
    return ExitCode.Ok;
  }

  ctx.logger.blank();
  ctx.logger.detail(`config file: ${file}`);
  ctx.logger.blank();

  const keyWidth = Math.max(...CONFIG_KEYS.map((key) => key.length));
  const origins = originMap(fileValues, envValues);

  const valueWidth = Math.max(20, Math.min(48, ctx.logger.columns - keyWidth - 16));

  for (const key of CONFIG_KEYS) {
    const origin = origins[key];
    const value = truncate(format(effective[key]), valueWidth);
    const badge =
      origin === 'env' ? c.warn('env') : origin === 'file' ? c.accent('file') : c.muted('default');
    ctx.logger.result(`  ${c.muted(padEnd(key, keyWidth))}  ${c.text(padEnd(value, valueWidth))}  ${badge}`);
  }

  ctx.logger.blank();
  ctx.logger.detail(`set with: vectrax config set <key> <value>  ${glyph.bullet}  env: ${envNameFor('outputDir')}=…`);
  return ExitCode.Ok;
}

export async function runConfigGet(ctx: CliContext, key: string): Promise<number> {
  assertKnownKey(key);
  const effective = await resolveConfig();
  const value = effective[key as keyof Config];
  ctx.logger.result(ctx.flags.json === true ? JSON.stringify(value) : format(value));
  return ExitCode.Ok;
}

export async function runConfigSet(ctx: CliContext, key: string, value: string): Promise<number> {
  assertKnownKey(key);
  const parsed = parseConfigValue(key, value);
  const file = configFilePath();
  const current = await readConfigFile(file);

  await writeConfigFile({ ...current, [key]: parsed } as Partial<ConfigInput>, file);
  ctx.logger.success(`${c.accent(key)} = ${c.text(format(parsed))}`);
  ctx.logger.detail(file);
  return ExitCode.Ok;
}

export async function runConfigUnset(ctx: CliContext, key: string): Promise<number> {
  assertKnownKey(key);
  const file = configFilePath();
  const current = await readConfigFile(file);
  if (!(key in current)) {
    ctx.logger.info(`${key} is not set in the config file; it already uses the default.`);
    return ExitCode.Ok;
  }
  const { [key as keyof ConfigInput]: _removed, ...rest } = current;
  await writeConfigFile(rest, file);
  ctx.logger.success(`Removed ${c.accent(key)} — reverted to the default.`);
  return ExitCode.Ok;
}

export function runConfigPath(ctx: CliContext): number {
  ctx.logger.result(configFilePath());
  return ExitCode.Ok;
}

function assertKnownKey(key: string): void {
  if (!(CONFIG_KEYS as string[]).includes(key)) {
    throw new ConfigError(`Unknown config key "${key}".`, {
      hint: `Valid keys: ${CONFIG_KEYS.join(', ')}.`,
    });
  }
}

function originMap(
  fileValues: Partial<ConfigInput>,
  envValues: Partial<ConfigInput>,
): Record<string, Origin> {
  return Object.fromEntries(
    CONFIG_KEYS.map((key) => [
      key,
      key in envValues ? 'env' : key in fileValues ? 'file' : 'default',
    ]),
  ) as Record<string, Origin>;
}

function format(value: unknown): string {
  if (Array.isArray(value)) return value.join(',');
  return String(value);
}
