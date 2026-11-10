/**
 * The `kns cache` command family.
 *
 * @module
 */

import { KnsError, ok } from '../core/errors.ts';
import { HitCache, cachePath } from '../cache/store.ts';
import { flagBoolean, flagString, unknownFlags } from './args.ts';
import type { ParsedArgs } from './args.ts';
import type { CliContext } from './zone.ts';

/** Flags accepted by the cache commands. */
const CACHE_FLAGS = ['json', 'zone'];

/**
 * Run a `kns cache` subcommand.
 *
 * @param args - Parsed command line, positional `['cache', subcommand]`.
 * @param context - Injected home directory and output sink.
 * @returns Zero on success. Failures throw {@link KnsError} for the caller to render.
 */
export async function runCache(args: ParsedArgs, context: CliContext): Promise<number> {
  const unknown = unknownFlags(args, CACHE_FLAGS);
  if (unknown.length > 0) {
    throw new KnsError(
      'invalid_request',
      `unknown flag(s): ${unknown.map((name) => `--${name}`).join(', ')}`,
      'run kns help',
    );
  }

  const subcommand = args.positional[1] ?? 'stats';
  const json = flagBoolean(args, 'json');
  const zone = flagString(args, 'zone');
  const store = new HitCache(cachePath(context.home));

  try {
    if (subcommand === 'stats') {
      const stats = store.stats();
      if (json) {
        context.write(JSON.stringify(ok(stats), null, 2));
      } else {
        const perZone = Object.entries(stats.byZone)
          .map(([name, count]) => `  ${name}: ${count}`)
          .join('\n');
        context.write(
          [`entries: ${stats.entries}`, perZone === '' ? '  (empty)' : perZone].join('\n'),
        );
      }
      return 0;
    }

    if (subcommand === 'purge') {
      const removed = store.purge(zone);
      context.write(
        json
          ? JSON.stringify(ok({ removed, zone }), null, 2)
          : `purged ${removed} entr${removed === 1 ? 'y' : 'ies'}${zone === null ? '' : ` for ${zone}`}`,
      );
      return 0;
    }

    throw new KnsError(
      'invalid_request',
      `unknown subcommand "cache ${subcommand}"`,
      'expected one of: stats, purge',
    );
  } finally {
    store.close();
  }
}
