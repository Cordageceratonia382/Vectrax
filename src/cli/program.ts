import { Command, Option } from 'commander';

import { ExitCode } from '../core/errors.js';
import type { ConfigInput } from '../config/schema.js';
import { MEDIA_KINDS } from '../core/scrape/media.js';
import { EDITABLE_FIELDS } from '../core/metadata/types.js';
import { DEFAULT_QUALITY, parseQuality, type MediaIntent, type QualityTargets } from '../core/quality.js';
import { KEEP_ORIGINAL, parseFormat, type FormatChoice } from '../core/convert/formats.js';
import { playBannerReaction, renderBanner, shouldShowBanner } from '../ui/banner.js';
import { c } from '../ui/theme.js';
import { VERSION } from '../version.js';
import { createContext, createInterruptController, type GlobalFlags } from './context.js';
import { collect, parseExtensions, parseInteger, parseKinds, parseRegex } from './options.js';
import { runGet } from './commands/get.js';
import { runScan } from './commands/scan.js';
import { runTag } from './commands/tag.js';
import {
  runConfigGet,
  runConfigList,
  runConfigPath,
  runConfigSet,
  runConfigUnset,
} from './commands/config.js';

type Flags = Record<string, unknown>;

const advancedRequested = (): boolean => process.argv.includes('--advanced');

function advanced(option: Option): Option {
  return advancedRequested() ? option : option.hideHelp();
}

function withEssentialOptions(command: Command): Command {
  return command
    .addOption(new Option('-o, --output <dir>', 'where to save files'))
    .addOption(
      new Option('-q, --quality <level>', 'best | high | balanced | small, or 320k / 1080p').default(
        'balanced',
      ),
    )
    .addOption(new Option('-a, --audio', 'prefer audio'))
    .addOption(new Option('-v, --video', 'prefer video'))
    .addOption(
      new Option('-f, --format <format>', 'mp3, m4a, flac, wav, opus, mp4, mkv, webm — or compatible / archive'),
    );
}

function withAdvancedOptions(command: Command): Command {
  return command
    .addOption(advanced(new Option('--select <expr>', 'select by index, e.g. 1,3,5-8')))
    .addOption(advanced(new Option('--limit <n>', 'cap items taken from a playlist').argParser((v) => parseInteger('--limit', v, 1, 1000))))
    .addOption(advanced(new Option('--kind <kinds...>', 'media categories to match').choices([...MEDIA_KINDS]).argParser(collect)))
    .addOption(advanced(new Option('--ext <extensions>', 'extra file extensions to accept').argParser(collect)))
    .addOption(advanced(new Option('--match <pattern>', 'keep only items matching this regex')))
    .addOption(advanced(new Option('--sizes', 'fetch sizes before selecting')))
    .addOption(advanced(new Option('--concurrency <n>', 'simultaneous transfers (1-16)').argParser((v) => parseInteger('--concurrency', v, 1, 16))))
    .addOption(advanced(new Option('--retries <n>', 'retry attempts per file (0-10)').argParser((v) => parseInteger('--retries', v, 0, 10))))
    .addOption(advanced(new Option('--timeout <ms>', 'response-header timeout').argParser((v) => parseInteger('--timeout', v, 1000, 600_000))))
    .addOption(advanced(new Option('--referer <value>', 'Referer header: auto, none, or a URL')))
    .addOption(advanced(new Option('--user-agent <value>', 'User-Agent header')))
    .addOption(advanced(new Option('--conflict <policy>', 'when a filename is taken').choices(['rename', 'skip', 'overwrite'])))
    .addOption(advanced(new Option('--no-resume', 'ignore partial files from a previous run')))
    .addOption(advanced(new Option('--allow-private', 'permit private or loopback addresses')))
    .addOption(advanced(new Option('--no-insecure', 'refuse plaintext http:// URLs')));
}

function overridesFrom(flags: Flags): Partial<ConfigInput> {
  const overrides: Partial<ConfigInput> = {};
  const set = <K extends keyof ConfigInput>(key: K, value: ConfigInput[K] | undefined): void => {
    if (value !== undefined) overrides[key] = value;
  };

  set('outputDir', flags['output'] as string | undefined);
  set('concurrency', flags['concurrency'] as number | undefined);
  set('retries', flags['retries'] as number | undefined);
  set('timeoutMs', flags['timeout'] as number | undefined);
  set('referer', flags['referer'] as string | undefined);
  set('userAgent', flags['userAgent'] as string | undefined);
  set('conflict', flags['conflict'] as ConfigInput['conflict']);
  if (flags['resume'] === false) overrides.resume = false;
  if (flags['allowPrivate'] === true) overrides.allowPrivateHosts = true;
  if (flags['insecure'] === false) overrides.allowInsecure = false;
  if (flags['fallback'] === false) overrides.fallback = false;

  const kind = flags['kind'] as string[] | undefined;
  if (kind !== undefined && kind.length > 0) overrides.kinds = parseKinds(kind);
  return overrides;
}

function mediaIntentFrom(flags: Flags): MediaIntent {
  if (flags['video'] === true) return 'video';
  if (flags['audio'] === true) return 'audio';
  return 'auto';
}

function formatFrom(flags: Flags): FormatChoice {
  const value = flags['format'];
  return typeof value === 'string' ? parseFormat(value) : KEEP_ORIGINAL;
}

function qualityFrom(flags: Flags): QualityTargets {
  const value = flags['quality'];
  return typeof value === 'string' ? parseQuality(value) : DEFAULT_QUALITY;
}

function discoveryFrom(flags: Flags): {
  kinds: string[] | undefined;
  extensions: string[] | undefined;
  match: RegExp | undefined;
  media: MediaIntent;
  quality: QualityTargets;
  limit: number | undefined;
  sizes: boolean;
} {
  const kind = flags['kind'] as string[] | undefined;
  const ext = flags['ext'] as string[] | undefined;
  const match = flags['match'];
  return {
    kinds: kind !== undefined && kind.length > 0 ? parseKinds(kind) : undefined,
    extensions: ext !== undefined ? parseExtensions(ext) : undefined,
    match: typeof match === 'string' ? parseRegex('--match', match) : undefined,
    media: mediaIntentFrom(flags),
    quality: qualityFrom(flags),
    limit: typeof flags['limit'] === 'number' ? flags['limit'] : undefined,
    sizes: flags['sizes'] === true,
  };
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('vectrax')
    .description('Extract and download media from YouTube or any page.')
    .version(VERSION, '-V, --version', 'print the version')
    .option('--json', 'emit machine-readable JSON')
    .option('--quiet', 'only report errors')
    .option('--verbose', 'include debug diagnostics')
    .option('--advanced', 'show every option in help')
    .addOption(new Option('--no-banner', 'suppress the banner').hideHelp(!advancedRequested()))
    .addOption(new Option('--config <file>', 'use an alternate config file').hideHelp(!advancedRequested()))
    .showHelpAfterError('(run `vectrax --help` for usage)')
    .configureHelp({ sortSubcommands: false, sortOptions: false });

  program.addHelpText('beforeAll', () =>
    shouldShowBanner({ ...globalFlags(program), stream: process.stdout })
      ? renderBanner({ version: VERSION })
      : '',
  );

  program.addHelpText('after', helpFooter());

  const get = withAdvancedOptions(
    withEssentialOptions(
      new Command('get')
        .alias('dl')
        .description('download media from a link')
        .argument('<url>', 'page, video, track, or playlist link'),
    ),
  )
    .addOption(new Option('--all', 'take everything without asking'))
    .addOption(new Option('-y, --yes', 'skip confirmation prompts'))
    .addOption(advanced(new Option('-n, --dry-run', 'resolve and report without downloading')))
    .addOption(advanced(new Option('--move <dir>', 'move completed files here afterwards')))
    .addOption(advanced(new Option('--no-tag', 'do not write metadata into downloaded files')))
    .addOption(advanced(new Option('--no-artwork', 'do not embed cover art')))
    .addOption(advanced(new Option('--no-fallback', 'do not retry failures with yt-dlp')))
    .addOption(advanced(new Option('--install-fallback', 'allow installing yt-dlp without asking')))
    .action(async (url: string, flags: Flags) => {
      await run(program, overridesFrom(flags), async (ctx) =>
        runGet(ctx, url, {
          ...discoveryFrom(flags),
          all: flags['all'] === true,
          select: typeof flags['select'] === 'string' ? flags['select'] : undefined,
          yes: flags['yes'] === true,
          dryRun: flags['dryRun'] === true,
          move: typeof flags['move'] === 'string' ? flags['move'] : undefined,
          tag: flags['tag'] !== false,
          artwork: flags['artwork'] !== false,
          fallback: flags['fallback'] !== false,
          installFallback: flags['installFallback'] === true,
          format: formatFrom(flags),
        }),
      );
    });

  const scan = withAdvancedOptions(
    withEssentialOptions(
      new Command('scan')
        .alias('ls')
        .description('list what a link offers, without downloading')
        .argument('<url>', 'page, video, track, or playlist link'),
    ),
  ).action(async (url: string, flags: Flags) => {
    await run(program, overridesFrom(flags), async (ctx) => runScan(ctx, url, discoveryFrom(flags)));
  });

  const tag = new Command('tag')
    .description('view and edit audio metadata')
    .argument('<files...>', 'audio files to inspect or edit')
    .option('-s, --set <assignment...>', 'set a field, e.g. --set artist="Nina Simone"', collect)
    .option('-i, --interactive', 'edit fields one by one')
    .option('--artwork <source>', 'embed cover art from a path or URL')
    .addOption(advanced(new Option('--remove-artwork', 'strip embedded cover art')))
    .addOption(advanced(new Option('--export-artwork <file>', 'write embedded cover art to a file')))
    .addOption(advanced(new Option('--clear', 'remove all metadata')))
    .option('-y, --yes', 'skip confirmation prompts')
    .addHelpText('after', `\n${c.accent('Fields')}\n  ${EDITABLE_FIELDS.join(', ')}\n`)
    .action(async (files: string[], flags: Flags) => {
      await run(program, {}, async (ctx) =>
        runTag(ctx, files, {
          set: Array.isArray(flags['set']) ? (flags['set'] as string[]) : undefined,
          artwork: typeof flags['artwork'] === 'string' ? flags['artwork'] : undefined,
          removeArtwork: flags['removeArtwork'] === true,
          exportArtwork: typeof flags['exportArtwork'] === 'string' ? flags['exportArtwork'] : undefined,
          clear: flags['clear'] === true,
          interactive: flags['interactive'] === true,
          yes: flags['yes'] === true,
        }),
      );
    });

  const config = new Command('config').description('view and edit saved settings');

  config
    .command('list', { isDefault: true })
    .description('show the effective configuration')
    .action(async () => {
      await run(program, {}, runConfigList);
    });
  config
    .command('get <key>')
    .description('print a single value')
    .action(async (key: string) => {
      await run(program, {}, async (ctx) => runConfigGet(ctx, key));
    });
  config
    .command('set <key> <value>')
    .description('save a value')
    .action(async (key: string, value: string) => {
      await run(program, {}, async (ctx) => runConfigSet(ctx, key, value));
    });
  config
    .command('unset <key>')
    .description('revert a value to its default')
    .action(async (key: string) => {
      await run(program, {}, async (ctx) => runConfigUnset(ctx, key));
    });
  config
    .command('path')
    .description('print the config file location')
    .action(async () => {
      await run(program, {}, async (ctx) => runConfigPath(ctx));
    });

  program.addCommand(get, { isDefault: true });
  program.addCommand(scan);
  program.addCommand(tag);
  program.addCommand(config);

  return program;
}

function helpFooter(): string {
  const example = (command: string, note: string): string =>
    `  ${c.muted('$')} ${command.padEnd(49)}${c.muted(note)}`;

  const base = [
    '',
    c.accent('Examples'),
    example('vectrax https://youtu.be/dQw4w9WgXcQ', 'a song, tagged'),
    example('vectrax <playlist-url> --all', 'a whole playlist'),
    example('vectrax <url> --video --quality 1080p', 'video instead'),
    example('vectrax <url> --quality best', 'maximum quality'),
    example('vectrax <url> --format mp3', 'convert after downloading'),
    example('vectrax scan <url>', 'look before downloading'),
    example('vectrax tag song.mp3 --set artist="Nina Simone"', 'edit metadata'),
    '',
    `${c.muted('Vectrax picks the source, format, and quality for you. Interrupted transfers resume.')}`,
  ];

  if (!advancedRequested()) {
    base.push(`${c.muted('Run')} vectrax --advanced --help ${c.muted('to see every option.')}`);
  }
  return `${base.join('\n')}\n`;
}

function globalFlags(program: Command): GlobalFlags & { json: boolean; quiet: boolean; noBanner: boolean } {
  const opts = program.opts<{
    json?: boolean;
    quiet?: boolean;
    verbose?: boolean;
    banner?: boolean;
    config?: string;
  }>();
  return {
    json: opts.json === true,
    quiet: opts.quiet === true,
    noBanner: opts.banner === false,
    ...(opts.verbose !== undefined ? { verbose: opts.verbose } : {}),
    ...(opts.config !== undefined ? { config: opts.config } : {}),
  };
}

async function run(
  program: Command,
  overrides: Partial<ConfigInput>,
  handler: (ctx: Awaited<ReturnType<typeof createContext>>) => Promise<number> | number,
): Promise<void> {
  const flags = globalFlags(program);

  if (shouldShowBanner(flags)) await playBannerReaction({ version: VERSION });

  const { controller, dispose } = createInterruptController();
  try {
    const ctx = await createContext({ flags, overrides, signal: controller.signal });
    process.exitCode = (await handler(ctx)) as number;
  } finally {
    dispose();
  }

  if (controller.signal.aborted && (process.exitCode ?? 0) === ExitCode.Ok) {
    process.exitCode = ExitCode.Interrupted;
  }
}
