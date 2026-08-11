/**
 * The resolution walk.
 *
 * This module holds the routing decision — which zones to ask, in what order, and
 * when to stop — and nothing else. Talking to a zone is the client's job; ordering
 * results is the ranker's.
 *
 * At this stage the walk reaches the nearest distance band only. Fanning outward
 * arrives with fusion, because concatenating results from several bands without a way
 * to compare them across engines would produce an order nobody could defend.
 *
 * @module
 */

import type { KnsConfig } from '../core/config.ts';
import type { Registry } from '../core/registry.ts';
import { groupByDistance, selectZones } from '../core/registry.ts';
import type { Hit, ResolveRequest, ResolveResult, Warning, Zone } from '../core/types.ts';
import { KnsError } from '../core/errors.ts';
import type { ZoneClient } from '../zone/client.ts';
import { annotate } from './annotate.ts';

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
): Promise<ZoneOutcome> {
  const client = deps.createClient(zone);
  const now = deps.now ?? new Date();

  try {
    const raw = await client.search(request.query, request.k, deps.config.resolution.zoneDeadlineMs);
    return { zone, hits: annotate(raw, zone, now), warning: null };
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

  const hits: Hit[] = [];
  const warnings: Warning[] = [];
  const zonesQueried: string[] = [];

  const band = bands[0];
  if (band !== undefined) {
    const outcomes = await withConcurrency(
      band.map((zone) => () => queryZone(zone, request, deps)),
      deps.config.resolution.maxConcurrentZones,
    );

    for (const outcome of outcomes) {
      zonesQueried.push(outcome.zone.name);
      hits.push(...outcome.hits);
      if (outcome.warning !== null) warnings.push(outcome.warning);
    }
  }

  if (zones.length === 0) {
    warnings.push({
      code: 'invalid_request',
      zone: null,
      message:
        request.scope === null
          ? 'no zones configured'
          : `no zones match scope "${request.scope}"`,
    });
  }

  return {
    hits: hits.slice(0, request.k),
    zonesQueried,
    earlyExitAt: bands.length > 1 && band !== undefined ? band[0]?.distance ?? null : null,
    partial: warnings.some((warning) => warning.zone !== null),
    resolveMs: Date.now() - started,
    warnings,
  };
}
