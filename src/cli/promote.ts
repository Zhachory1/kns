/**
 * The `kns promote` command family.
 *
 * `suggest` reads and ranks; it writes nothing. Drafting and publishing arrive in
 * later commits and are gated on the sanitizer.
 *
 * @module
 */

import { KnsError, ok } from '../core/errors.ts';
import { loadRegistry } from '../core/registry.ts';
import type { Registry } from '../core/registry.ts';
import { readCorpus, suggest } from '../promote/suggest.ts';
import type { Suggestion } from '../promote/suggest.ts';
import { flagBoolean, flagString, unknownFlags } from './args.ts';
import type { ParsedArgs } from './args.ts';
import type { CliContext } from './zone.ts';

/** Flags accepted by the promote commands. */
const PROMOTE_FLAGS = ['json', 'to', 'limit'];

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

    let suggestions = suggest(documents, new Date());
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

  throw new KnsError(
    'invalid_request',
    `unknown subcommand "promote ${subcommand}"`,
    'expected one of: suggest',
  );
}
