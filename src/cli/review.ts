/**
 * The `kns review` command.
 *
 * @module
 */

import { KnsError, ok } from '../core/errors.ts';
import { loadRegistry } from '../core/registry.ts';
import { DEFAULT_REVIEW_DAYS } from '../promote/draft.ts';
import { publish, realExec } from '../promote/publish.ts';
import { findStale, renewReview } from '../promote/review.ts';
import { readCorpus } from '../promote/suggest.ts';
import { flagBoolean, flagNumber, flagString, unknownFlags } from './args.ts';
import type { ParsedArgs } from './args.ts';
import { targetZoneRoot } from './promote.ts';
import type { CliContext } from './zone.ts';

/** Flags accepted by the review command. */
const REVIEW_FLAGS = ['json', 'zone', 'renew', 'demote', 'confirm', 'as', 'review-days'];

/**
 * Run `kns review`.
 *
 * Listing is the default and is read-only. Renewing or demoting changes a shared zone,
 * so both require an explicit confirmation and both go through a pull request.
 *
 * @param args - Parsed command line.
 * @param context - Injected home directory and output sink.
 * @returns Zero on success. Failures throw {@link KnsError} for the caller to render.
 */
export async function runReview(args: ParsedArgs, context: CliContext): Promise<number> {
  const unknown = unknownFlags(args, REVIEW_FLAGS);
  if (unknown.length > 0) {
    throw new KnsError(
      'invalid_request',
      `unknown flag(s): ${unknown.map((name) => `--${name}`).join(', ')}`,
      'run kns help',
    );
  }

  const zoneName = flagString(args, 'zone');
  if (zoneName === null) {
    throw new KnsError('invalid_request', '--zone <name> is required', 'run kns zone list');
  }

  const registry = await loadRegistry(context.home);
  const { zone, root } = targetZoneRoot(registry, zoneName);
  const now = new Date();
  const items = findStale(await readCorpus(root), now);

  const renew = flagString(args, 'renew');
  const demote = flagString(args, 'demote');

  if (renew === null && demote === null) {
    context.write(
      flagBoolean(args, 'json')
        ? JSON.stringify(ok({ zone: zone.name, items }), null, 2)
        : items.length === 0
          ? `${zone.name}: nothing needs review`
          : items
              .map((item) => [`${item.documentId}`, ...item.reasons.map((reason) => `  - ${reason}`)].join('\n'))
              .join('\n'),
    );
    return 0;
  }

  if (!flagBoolean(args, 'confirm')) {
    throw new KnsError(
      'invalid_request',
      '--confirm is required to change a shared zone',
      'run kns review --zone <name> first to see what would change',
    );
  }

  const promotedBy = flagString(args, 'as') ?? process.env['USER'] ?? 'unknown';

  if (renew !== null) {
    const reviewBy = await renewReview(root, renew, now, flagNumber(args, 'review-days') ?? DEFAULT_REVIEW_DAYS);
    const result = await publish({
      zoneRoot: root,
      documentId: renew,
      zoneName: zone.name,
      promotedBy,
      now,
      exec: realExec,
    });

    context.write(
      flagBoolean(args, 'json')
        ? JSON.stringify(ok({ ...result, documentId: renew, reviewBy }), null, 2)
        : `renewed ${renew} until ${reviewBy} on branch ${result.branch}\n${result.url ?? ''}`,
    );
    return 0;
  }

  const result = await publish({
    zoneRoot: root,
    documentId: demote as string,
    zoneName: zone.name,
    promotedBy,
    now,
    exec: realExec,
    remove: true,
  });

  context.write(
    flagBoolean(args, 'json')
      ? JSON.stringify(ok({ ...result, documentId: demote }), null, 2)
      : `demotion opened for ${demote ?? ''} on branch ${result.branch}\n${result.url ?? ''}`,
  );
  return 0;
}
