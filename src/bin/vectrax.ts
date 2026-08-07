import { CommanderError } from 'commander';

import { buildProgram } from '../cli/program.js';
import { ExitCode, errorMessage, isAbortError, isVectraxError } from '../core/errors.js';
import { ansi, c, glyph } from '../ui/theme.js';

function restoreTerminal(): void {
  if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
  if (process.stderr.isTTY) process.stderr.write(ansi.showCursor);
}

function reportError(error: unknown): number {
  restoreTerminal();

  if (isAbortError(error)) {
    process.stderr.write(`\n${c.warn(glyph.warn)} ${c.text('Interrupted.')} ${c.muted('Partial downloads were kept — re-run to resume.')}\n`);
    return ExitCode.Interrupted;
  }

  if (isVectraxError(error)) {
    process.stderr.write(`\n${c.danger(glyph.cross)} ${c.text(error.message)}\n`);
    if (error.hint !== undefined) {
      process.stderr.write(`  ${c.muted(error.hint)}\n`);
    }
    if (process.env['VECTRAX_DEBUG'] !== undefined && error.stack !== undefined) {
      process.stderr.write(`${c.muted(error.stack)}\n`);
    }
    return error.exitCode;
  }

  process.stderr.write(`\n${c.danger(glyph.cross)} ${c.text('Unexpected error.')} ${c.muted('This is a bug in Vectrax.')}\n`);
  process.stderr.write(`${c.muted(error instanceof Error ? (error.stack ?? error.message) : errorMessage(error))}\n`);
  return ExitCode.Failure;
}

async function main(): Promise<void> {
  process.on('exit', restoreTerminal);

  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(ExitCode.Ok);
  });

  try {
    await buildProgram().parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode === 0 ? ExitCode.Ok : ExitCode.UsageError;
      return;
    }
    process.exitCode = reportError(error);
  }
}

await main();
