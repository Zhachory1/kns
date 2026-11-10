/**
 * Early-exit policy — the DNS cache-hit path.
 *
 * Fanning out to every zone on every query costs a process spawn per zone per query
 * per user. When the nearest band already holds a clear, fresh answer, the walk should
 * stop there.
 *
 * The policy is conservative by construction: every condition must hold, and anything
 * unknown counts against stopping. Exiting early when the real answer lived further
 * out is a wrong answer; continuing when it did not is merely slower.
 *
 * @module
 */

import type { EarlyExitConfig } from '../core/config.ts';
import type { Hit, ResolveRequest, Zone } from '../core/types.ts';

/** Why the walk did or did not stop at a band. */
export interface EarlyExitDecision {
  /** True when the walk may stop here. */
  stop: boolean;
  /** Human-readable justification, surfaced by `--explain`. */
  reason: string;
}

/**
 * Normalised margin between the top two hits.
 *
 * A single hit has nothing to be ambiguous against, so it scores a full margin.
 *
 * @param hits - Band hits, already ranked.
 * @returns A value in [0, 1].
 */
export function topMargin(hits: readonly Hit[]): number {
  const top = hits[0];
  if (top === undefined || top.score <= 0) return 0;

  const runnerUp = hits[1];
  if (runnerUp === undefined) return 1;

  return (top.score - runnerUp.score) / top.score;
}

/**
 * Decide whether the walk may stop at this band.
 *
 * @param hits - Ranked hits produced by this band.
 * @param band - Zones in the band, checked for `neverEarlyExit`.
 * @param request - The request, for `mode` and `noEarlyExit`.
 * @param config - Early-exit thresholds.
 * @returns The decision and the reason behind it.
 */
export function decideEarlyExit(
  hits: readonly Hit[],
  band: readonly Zone[],
  request: ResolveRequest,
  config: EarlyExitConfig,
): EarlyExitDecision {
  if (request.noEarlyExit) return { stop: false, reason: 'early exit disabled by the caller' };
  if (request.mode === 'broad') return { stop: false, reason: 'broad mode queries every zone' };

  const pinned = band.find((zone) => zone.neverEarlyExit);
  if (pinned !== undefined) {
    return { stop: false, reason: `zone "${pinned.name}" is configured to never stop the walk` };
  }

  if (hits.length < config.minHits) {
    return { stop: false, reason: `band returned ${hits.length} hit(s), below minHits ${config.minHits}` };
  }

  const top = hits[0];
  if (top === undefined) return { stop: false, reason: 'band returned no hits' };

  const age = top.provenance.ageDays;
  if (age === null) {
    // An undated top hit cannot be shown to be fresh, and freshness is the whole
    // justification for trusting a near answer over a further one.
    return { stop: false, reason: 'top hit has no known age' };
  }
  if (age > config.authoritativeMaxAgeDays) {
    return {
      stop: false,
      reason: `top hit is ${age}d old, beyond authoritativeMaxAgeDays ${config.authoritativeMaxAgeDays}`,
    };
  }

  const margin = topMargin(hits);
  if (margin < config.marginMin) {
    return {
      stop: false,
      reason: `top hit leads by ${margin.toFixed(3)}, below marginMin ${config.marginMin}`,
    };
  }

  return {
    stop: true,
    reason: `top hit is ${age}d old and leads by ${margin.toFixed(3)}`,
  };
}
