/**
 * `kns` command dispatch.
 *
 * Commands throw {@link KnsError}; this module is the single place that turns a
 * failure into an envelope and an exit code, so every command reports failures the
 * same way.
 *
 * @module
 */

import { KnsError, toErrorEnvelope } from '../core/errors.ts';
import type { ErrorCode } from '../core/errors.ts';
import { knsHome } from '../core/registry.ts';
import { describeVersion } from '../version.ts';
import { flagBoolean, parseArgs } from './args.ts';
import { runResolve } from './resolve.ts';
import { runZone } from './zone.ts';
import type { CliContext } from './zone.ts';

/** Usage text, kept short: the contract documents are the real reference. */
export const USAGE = `kns — hierarchical retrieval across local, team, and company zones

usage:
  kns zone list [--scope <namespace>] [--json]
  kns zone show <name> [--json]
  kns zone add --name <n> --namespace <ns> --tier USER|TEAM|COMPANY \\
               --distance <n> --root <path> [--ttl-seconds <n>] [--json]
  kns zone remove <name> [--json]
  kns resolve <query> [--k <n>] [--mode exact|broad] [--scope <ns>]
                      [--no-early-exit] [--json]
  kns --version

docs: DESIGN.md, docs/contract-cli.md`;

/**
 * Map an error code to a process exit code.
 *
 * A degraded result is not a failure, so partial resolutions never reach this
 * function — they exit zero with warnings in the envelope.
 *
 * @param code - Error code from a failed command.
 * @returns The process exit code.
 */
export function exitCodeFor(code: ErrorCode): number {
  if (code === 'sanitizer_blocked') return 2;
  if (code === 'internal') return 3;
  return 1;
}

/**
 * Run the CLI.
 *
 * @param argv - Arguments, excluding the executable and script paths.
 * @param context - Injected home directory and output sinks.
 * @returns The process exit code.
 */
export async function run(
  argv: readonly string[],
  context: { home?: string; write: (text: string) => void; writeError: (text: string) => void },
): Promise<number> {
  const args = parseArgs(argv);
  const cli: CliContext = { home: context.home ?? knsHome(), write: context.write };
  const json = flagBoolean(args, 'json');

  try {
    if (flagBoolean(args, 'version')) {
      context.write(describeVersion());
      return 0;
    }

    const command = args.positional[0];
    if (command === undefined || command === 'help' || flagBoolean(args, 'help')) {
      context.write(USAGE);
      return 0;
    }

    if (command === 'zone') return await runZone(args, cli);
    if (command === 'resolve') return await runResolve(args, cli);

    throw new KnsError(
      'invalid_request',
      `unknown command "${command}"`,
      'run kns help for usage',
    );
  } catch (error) {
    const envelope = toErrorEnvelope(error);
    context.writeError(
      json ? JSON.stringify(envelope, null, 2) : `error [${envelope.error.code}] ${envelope.error.message}`,
    );
    if (!json && envelope.error.nextStep !== null) {
      context.writeError(`next: ${envelope.error.nextStep}`);
    }
    return exitCodeFor(envelope.error.code as ErrorCode);
  }
}
