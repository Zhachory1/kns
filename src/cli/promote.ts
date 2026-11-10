/**
 * The `kns promote` command family.
 *
 * `suggest` reads and ranks; it writes nothing. Drafting and publishing arrive in
 * later commits and are gated on the sanitizer.
 *
 * @module
 */

import { KnsError, ok } from '../core/errors.ts';
import { findZone, loadRegistry } from '../core/registry.ts';
import type { Registry } from '../core/registry.ts';
import type { Zone } from '../core/types.ts';
import { buildDraft, readSource, writeDraft } from '../promote/draft.ts';
import {
  clearOriginPointer,
  publish,
  qualifiedPath,
  realExec,
  writeOriginPointer,
} from '../promote/publish.ts';
import { formatFindings } from '../promote/sanitize.ts';
import { readCorpus, suggest } from '../promote/suggest.ts';
import { cachePath } from '../cache/store.ts';
import { DemandStore } from '../signal/demand.ts';
import { loadSignalSettings } from '../signal/settings.ts';
import type { Suggestion } from '../promote/suggest.ts';
import { flagBoolean, flagNumber, flagString, unknownFlags } from './args.ts';
import type { ParsedArgs } from './args.ts';
import type { CliContext } from './zone.ts';

/** Flags accepted by the promote commands. */
const PROMOTE_FLAGS = ['json', 'to', 'limit', 'dry-run', 'as', 'review-days', 'confirm'];

/**
 * Locate the corpus directory behind the private zone.
 *
 * The root is read from the registry entry rather than taken as a flag, so a
 * promotion always concerns the corpus KNS actually searches.
 *
 * @param registry - Loaded registry.
 * @returns Absolute corpus path.
 * @throws {KnsError} When no private zone is configured with a readable root.
 */
export function userCorpusRoot(registry: Registry): string {
  const zone = registry.zones
    .filter((entry) => entry.tier === 'USER')
    .sort((left, right) => left.distance - right.distance)[0];

  if (zone === undefined) {
    throw new KnsError(
      'invalid_request',
      'no USER zone is configured',
      'add one with: kns zone add --tier USER --root <path>',
    );
  }

  const index = zone.transport.args.indexOf('--root');
  const root = index === -1 ? undefined : zone.transport.args[index + 1];
  if (root === undefined || root === '') {
    throw new KnsError(
      'invalid_request',
      `zone "${zone.name}" does not declare a --root path`,
      'recreate it with: kns zone add --root <path>',
    );
  }
  return root;
}

/**
 * Locate the checkout behind a named target zone.
 *
 * @param registry - Loaded registry.
 * @param name - Zone name.
 * @returns Absolute path to the zone's checkout.
 * @throws {KnsError} When the zone is unknown or declares no root.
 */
export function targetZoneRoot(registry: Registry, name: string): { zone: Zone; root: string } {
  const zone = findZone(registry, name);
  if (zone === null) {
    throw new KnsError('invalid_request', `no zone named "${name}"`, 'run kns zone list');
  }
  if (zone.tier === 'USER') {
    throw new KnsError(
      'invalid_request',
      `zone "${name}" is the private tier; promotion targets a shared zone`,
      'promote to a TEAM or COMPANY zone',
    );
  }

  const index = zone.transport.args.indexOf('--root');
  const root = index === -1 ? undefined : zone.transport.args[index + 1];
  if (root === undefined || root === '') {
    throw new KnsError('invalid_request', `zone "${name}" does not declare a --root path`);
  }
  return { zone, root };
}

/** Render a suggestion for human-readable output. */
function describeSuggestion(suggestion: Suggestion, index: number): string {
  const marker = suggestion.blocked ? 'BLOCKED' : `score ${suggestion.score}`;
  return [
    `${index + 1}. ${suggestion.documentId}  (${marker})`,
    ...suggestion.reasons.map((reason) => `   - ${reason}`),
  ].join('\n');
}

/**
 * Run a `kns promote` subcommand.
 *
 * @param args - Parsed command line, positional `['promote', subcommand, ...]`.
 * @param context - Injected home directory and output sink.
 * @returns Zero on success. Failures throw {@link KnsError} for the caller to render.
 */
export async function runPromote(args: ParsedArgs, context: CliContext): Promise<number> {
  const unknown = unknownFlags(args, PROMOTE_FLAGS);
  if (unknown.length > 0) {
    throw new KnsError(
      'invalid_request',
      `unknown flag(s): ${unknown.map((name) => `--${name}`).join(', ')}`,
      'run kns help',
    );
  }

  const subcommand = args.positional[1] ?? 'suggest';

  if (subcommand === 'suggest') {
    const registry = await loadRegistry(context.home);
    const documents = await readCorpus(userCorpusRoot(registry));
    const target = flagString(args, 'to');

    const signal = await loadSignalSettings(context.home);
    let demandCounts: Record<string, number> = {};
    if (signal.enabled) {
      const demand = new DemandStore(cachePath(context.home));
      try {
        demandCounts = demand.countsByDocument();
      } finally {
        demand.close();
      }
    }

    let suggestions = suggest(documents, new Date(), demandCounts);
    if (target !== null) {
      suggestions = suggestions.filter(
        (suggestion) => suggestion.requestedScope === null || suggestion.requestedScope === target,
      );
    }

    if (flagBoolean(args, 'json')) {
      context.write(JSON.stringify(ok({ suggestions }), null, 2));
    } else if (suggestions.length === 0) {
      context.write('no promotion candidates — tag a document with "share: team" to propose one');
    } else {
      context.write(suggestions.map(describeSuggestion).join('\n'));
    }
    return 0;
  }

  if (subcommand === 'draft') {
    const documentId = args.positional[2];
    if (documentId === undefined) {
      throw new KnsError('invalid_request', 'document id is required', 'kns promote draft <id> --to <zone>');
    }

    const target = flagString(args, 'to');
    if (target === null) {
      throw new KnsError('invalid_request', '--to <zone> is required', 'run kns zone list');
    }

    const registry = await loadRegistry(context.home);
    const { zone, root } = targetZoneRoot(registry, target);
    const sourceText = await readSource(userCorpusRoot(registry), documentId);
    const reviewDays = flagNumber(args, 'review-days');

    const plan = buildDraft({
      documentId,
      sourceText,
      targetRoot: root,
      zone,
      promotedBy: flagString(args, 'as') ?? process.env['USER'] ?? 'unknown',
      now: new Date(),
      ...(reviewDays === null ? {} : { reviewDays }),
    });

    const dryRun = flagBoolean(args, 'dry-run');
    if (!dryRun) await writeDraft(plan);

    if (flagBoolean(args, 'json')) {
      context.write(
        JSON.stringify(
          ok({
            documentId: plan.documentId,
            targetFile: plan.targetFile,
            written: !dryRun,
            findings: plan.sanitizer.findings,
            contents: dryRun ? plan.contents : undefined,
          }),
          null,
          2,
        ),
      );
    } else {
      context.write(
        [
          formatFindings(plan.sanitizer),
          dryRun ? `would write ${plan.targetFile}` : `wrote ${plan.targetFile}`,
          dryRun ? '' : 'review it, then: kns promote publish --confirm',
        ]
          .filter((line) => line !== '')
          .join('\n'),
      );
    }
    return 0;
  }

  if (subcommand === 'publish' || subcommand === 'revoke') {
    const documentId = args.positional[2];
    if (documentId === undefined) {
      throw new KnsError(
        'invalid_request',
        'document id is required',
        `kns promote ${subcommand} <id> --to <zone> --confirm`,
      );
    }

    const target = flagString(args, 'to');
    if (target === null) {
      throw new KnsError('invalid_request', '--to <zone> is required', 'run kns zone list');
    }

    // There is no silent publish path. Crossing the privacy boundary is always an
    // explicit act, even for a caller that has already typed the document id.
    if (!flagBoolean(args, 'confirm')) {
      throw new KnsError(
        'invalid_request',
        `--confirm is required to ${subcommand} ${documentId}`,
        'review the draft first, then re-run with --confirm',
      );
    }

    const registry = await loadRegistry(context.home);
    const { zone, root } = targetZoneRoot(registry, target);
    const corpusRoot = userCorpusRoot(registry);
    const removing = subcommand === 'revoke';

    const result = await publish({
      zoneRoot: root,
      documentId,
      zoneName: zone.name,
      promotedBy: flagString(args, 'as') ?? process.env['USER'] ?? 'unknown',
      now: new Date(),
      exec: realExec,
      ...(removing ? { remove: true } : {}),
    });

    // The origin pointer is written only after the pull request exists. A pointer to a
    // promotion that never happened tells the author their knowledge is shared when it
    // is not.
    let pointer: string | null = null;
    if (removing) {
      await clearOriginPointer(corpusRoot, documentId).catch(() => false);
    } else {
      pointer = qualifiedPath(zone.namespace, documentId);
      await writeOriginPointer(corpusRoot, documentId, pointer);
    }

    if (flagBoolean(args, 'json')) {
      context.write(JSON.stringify(ok({ ...result, documentId, promotedTo: pointer }), null, 2));
    } else {
      context.write(
        [
          `${removing ? 'demotion' : 'promotion'} opened on branch ${result.branch}`,
          result.url === null ? 'no pull-request URL was reported' : result.url,
          removing ? 'origin pointer cleared' : `origin now records promoted_to: ${pointer ?? ''}`,
        ].join('\n'),
      );
    }
    return 0;
  }

  throw new KnsError(
    'invalid_request',
    `unknown subcommand "promote ${subcommand}"`,
    'expected one of: suggest, draft, publish, revoke',
  );
}
