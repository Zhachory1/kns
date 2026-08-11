/**
 * The `kns resolve` command.
 *
 * @module
 */

import { KnsError, ok } from '../core/errors.ts';
import { loadConfig } from '../core/config.ts';
import { loadRegistry } from '../core/registry.ts';
import type { Hit, ResolveResult } from '../core/types.ts';
import { issuesToError, parseResolveRequest } from '../core/validate.ts';
import { HitCache, cachePath } from '../cache/store.ts';
import { StdioZoneClient } from '../zone/client.ts';
import { resolve } from '../resolve/resolver.ts';
import type { ResolveDeps } from '../resolve/resolver.ts';
import { flagBoolean, flagNumber, flagString, unknownFlags } from './args.ts';
import type { ParsedArgs } from './args.ts';
import type { CliContext } from './zone.ts';

/** Flags accepted by `kns resolve`. */
const RESOLVE_FLAGS = ['json', 'k', 'mode', 'scope', 'no-early-exit', 'explain'];

/** Render one hit for human-readable output. */
function describeHit(hit: Hit, index: number): string {
  const { provenance } = hit;
  const age = provenance.ageDays === null ? 'age?' : `${provenance.ageDays}d`;
  const owner = provenance.owner ?? 'unowned';
  const flag = hit.conflict
    ? ` [conflict${hit.conflictWith.length > 0 ? ` with ${hit.conflictWith.join(', ')}` : ''}]`
    : '';
  const snippet = hit.snippet.replace(/\s+/g, ' ').slice(0, 120);

  return [
    `${index + 1}. ${hit.documentId}${flag}`,
    `   ${provenance.tier} ${provenance.zone} d=${provenance.distance} ${age} ${owner} score=${hit.score.toFixed(5)}`,
    `   ${snippet}`,
  ].join('\n');
}

/** Render the whole result for human-readable output. */
function describeResult(result: ResolveResult, explain: boolean): string {
  const lines: string[] = [];

  if (result.hits.length === 0) {
    lines.push('no hits');
  } else {
    lines.push(...result.hits.map((hit, index) => describeHit(hit, index)));
  }

  const exit = result.earlyExitAt === null ? 'none' : `distance ${result.earlyExitAt}`;
  lines.push(
    '',
    `zones: ${result.zonesQueried.join(', ') || 'none'} · early exit: ${exit} · ${result.resolveMs}ms${result.partial ? ' · partial' : ''}`,
  );
  if (explain) lines.push(`why: ${result.explanation}`);
  for (const warning of result.warnings) {
    lines.push(`warning [${warning.code}]${warning.zone === null ? '' : ` ${warning.zone}`}: ${warning.message}`);
  }
  return lines.join('\n');
}

/**
 * Run `kns resolve`.
 *
 * A zone that fails produces a warning and a partial result, not a failed command, so
 * this returns zero whenever the walk completed at all.
 *
 * @param args - Parsed command line, positional `['resolve', ...query]`.
 * @param context - Injected home directory and output sink.
 * @returns Zero on success. Failures throw {@link KnsError} for the caller to render.
 */
export async function runResolve(args: ParsedArgs, context: CliContext): Promise<number> {
  const unknown = unknownFlags(args, RESOLVE_FLAGS);
  if (unknown.length > 0) {
    throw new KnsError(
      'invalid_request',
      `unknown flag(s): ${unknown.map((name) => `--${name}`).join(', ')}`,
      'run kns help',
    );
  }

  const query = args.positional.slice(1).join(' ').trim();
  if (query === '') {
    throw new KnsError('invalid_request', 'query is required', 'kns resolve "<query>"');
  }

  const candidate: Record<string, unknown> = {
    query,
    mode: flagString(args, 'mode') ?? undefined,
    scope: flagString(args, 'scope'),
    noEarlyExit: flagBoolean(args, 'no-early-exit'),
  };
  const k = flagNumber(args, 'k');
  if (k !== null) candidate['k'] = k;
  if (candidate['mode'] === undefined) delete candidate['mode'];

  const parsed = parseResolveRequest(candidate);
  if (!parsed.ok) throw issuesToError(parsed.issues);

  const cache = new HitCache(cachePath(context.home));
  const deps: ResolveDeps = {
    registry: await loadRegistry(context.home),
    config: await loadConfig(context.home),
    createClient: (zone) => new StdioZoneClient(zone),
    cache,
  };

  let result;
  try {
    result = await resolve(parsed.value, deps);
  } finally {
    cache.close();
  }

  context.write(
    flagBoolean(args, 'json')
      ? JSON.stringify(ok(result), null, 2)
      : describeResult(result, flagBoolean(args, 'explain')),
  );
  return 0;
}
