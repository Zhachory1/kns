/**
 * The resolution walk.
 *
 * This module holds the routing decision — which zones to ask, in what order, and
 * when to stop — and nothing else. Talking to a zone is the client's job; ordering
 * results is the ranker's.
 *
 * The walk visits distance bands in order and queries the zones within a band in
 * parallel. Two deadlines bound it: one per zone, so a slow zone is dropped rather
 * than waited on, and one overall, so a wide registry cannot make a query unbounded.
 *
 * @module
 */

import type { KnsConfig } from '../core/config.ts';
import type { Registry } from '../core/registry.ts';
import { groupByDistance, selectZones } from '../core/registry.ts';
import type { Hit, ResolveRequest, ResolveResult, Warning, Zone } from '../core/types.ts';
import { KnsError } from '../core/errors.ts';
import type { HitCache } from '../cache/store.ts';
import type { ZoneClient } from '../zone/client.ts';
import { annotate } from './annotate.ts';
import { decideEarlyExit } from './early-exit.ts';
import { rankHits } from './rank.ts';

/** Creates a client for a zone. Injected so tests never spawn a process. */
export type ClientFactory = (zone: Zone) => ZoneClient;

/** Ambient inputs for a resolution. */
export interface ResolveDeps {
  /** Zones this machine knows about. */
  registry: Registry;
  /** Settings. */
  config: KnsConfig;
  /** How to reach a zone. */
  createClient: ClientFactory;
  /** Reference time, injected so ageing is testable. */
  now?: Date;
  /** TTL cache for shared zones. Omitted to disable caching entirely. */
  cache?: HitCache;
}

/** Outcome of querying one zone. */
interface ZoneOutcome {
  zone: Zone;
  hits: Hit[];
  warning: Warning | null;
}

/**
 * Query a single zone, converting any failure into a warning.
 *
 * A zone that fails degrades the result; it never fails the query. That is the whole
 * point of a hierarchy — the other zones may still know the answer.
 *
 * @param zone - Zone to query.
 * @param request - Validated request.
 * @param deps - Ambient inputs.
 * @returns The zone's annotated hits, or a warning describing why there are none.
 */
export async function queryZone(
  zone: Zone,
  request: ResolveRequest,
  deps: ResolveDeps,
  deadlineMs: number = deps.config.resolution.zoneDeadlineMs,
): Promise<ZoneOutcome> {
  const client = deps.createClient(zone);
  const now = deps.now ?? new Date();
  const cacheable = deps.cache !== undefined && zone.ttlSeconds > 0 && zone.tier !== 'USER';

  try {
    if (cacheable && deps.cache !== undefined) {
      const peeked = deps.cache.peek(zone.name, request.query, request.k, zone.ttlSeconds);
      if (peeked !== null) {
        // Revalidate against the zone's index generation. status() is a single cheap
        // call; a stale answer served for a full TTL after a reindex is not.
        const status = await client.status(deadlineMs);
        if ((status.generation ?? '') === peeked.generation) {
          deps.cache.touch(zone.name, request.query, request.k);
          return { zone, hits: peeked.hits, warning: null };
        }
      }
    }

    const raw = await client.search(request.query, request.k, deadlineMs);
    const hits = annotate(raw, zone, now);

    if (cacheable && deps.cache !== undefined) {
      const status = await client.status(deadlineMs);
      deps.cache.put(zone.name, request.query, request.k, status.generation, hits, zone.ttlSeconds);
    }
    return { zone, hits, warning: null };
  } catch (error) {
    const code = error instanceof KnsError ? error.code : 'internal';
    return {
      zone,
      hits: [],
      warning: {
        code,
        zone: zone.name,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    await client.close();
  }
}

/**
 * Run tasks with a ceiling on how many are in flight at once.
 *
 * Spawning one child process per zone without a cap turns a wide registry into a fork
 * bomb on the user's laptop.
 *
 * @param tasks - Thunks to run.
 * @param limit - Maximum concurrent tasks.
 * @returns Results in the order the tasks were given.
 */
export async function withConcurrency<T>(
  tasks: readonly (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= tasks.length) return;
      const task = tasks[index];
      if (task === undefined) return;
      results[index] = await task();
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Resolve a query across the hierarchy.
 *
 * @param request - Validated request.
 * @param deps - Ambient inputs.
 * @returns Hits with provenance, plus what the walk did and what went wrong.
 */
export async function resolve(request: ResolveRequest, deps: ResolveDeps): Promise<ResolveResult> {
  const started = Date.now();
  const zones = selectZones(deps.registry, request.scope);
  const bands = groupByDistance(zones);
  const byName = new Map(zones.map((zone) => [zone.name, zone]));

  const hits: Hit[] = [];
  const warnings: Warning[] = [];
  const zonesQueried: string[] = [];
  let earlyExitAt: number | null = null;
  let explanation = 'walk reached every zone';

  for (const band of bands) {
    const remaining = deps.config.resolution.resolveDeadlineMs - (Date.now() - started);
    if (remaining <= 0) {
      // The overall budget is spent. Report the zones that were never reached rather
      // than returning a result that silently looks complete.
      warnings.push({
        code: 'zone_timeout',
        zone: null,
        message: `overall deadline of ${deps.config.resolution.resolveDeadlineMs}ms reached; ${bands
          .flat()
          .filter((zone) => !zonesQueried.includes(zone.name))
          .map((zone) => zone.name)
          .join(', ')} not queried`,
      });
      break;
    }

    const deadlineMs = Math.min(deps.config.resolution.zoneDeadlineMs, remaining);
    const outcomes = await withConcurrency(
      band.map((zone) => () => queryZone(zone, request, deps, deadlineMs)),
      deps.config.resolution.maxConcurrentZones,
    );

    const bandHits: Hit[] = [];
    for (const outcome of outcomes) {
      zonesQueried.push(outcome.zone.name);
      hits.push(...outcome.hits);
      bandHits.push(...outcome.hits);
      if (outcome.warning !== null) warnings.push(outcome.warning);
    }

    const decision = decideEarlyExit(
      rankHits(bandHits, byName, deps.config.ranking),
      band,
      request,
      deps.config.earlyExit,
    );
    explanation = decision.reason;
    if (decision.stop) {
      earlyExitAt = band[0]?.distance ?? null;
      break;
    }
  }

  if (zones.length === 0) {
    warnings.push({
      code: 'invalid_request',
      zone: null,
      message:
        request.scope === null ? 'no zones configured' : `no zones match scope "${request.scope}"`,
    });
  }

  return {
    hits: rankHits(hits, byName, deps.config.ranking).slice(0, request.k),
    zonesQueried,
    earlyExitAt,
    explanation,
    partial: warnings.some((warning) => warning.code !== 'invalid_request'),
    resolveMs: Date.now() - started,
    warnings,
  };
}
