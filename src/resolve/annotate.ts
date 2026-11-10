/**
 * Turn engine results into annotated hits.
 *
 * Provenance is what makes a hit judgeable: which zone answered, who owns the
 * document, how old it is, and whether it has outlived its review date. Without it a
 * shared answer is indistinguishable from a private one.
 *
 * @module
 */

import type { Hit, Provenance, Zone } from '../core/types.ts';
import type { RawHit } from '../zone/client.ts';

/** Milliseconds in a day. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Compute a document's age in whole days.
 *
 * @param modified - ISO date string reported by the engine, or null.
 * @param now - Reference time, injected so tests are not clock-dependent.
 * @returns Age in days, or null when there is no usable date. Future dates clamp to 0.
 */
export function ageInDays(modified: string | null, now: Date): number | null {
  if (modified === null) return null;

  const timestamp = Date.parse(modified);
  if (Number.isNaN(timestamp)) return null;

  const elapsed = now.getTime() - timestamp;
  return elapsed <= 0 ? 0 : Math.floor(elapsed / DAY_MS);
}

/**
 * Decide whether a document has outlived its review date.
 *
 * @param reviewBy - ISO date from the document's frontmatter, or null.
 * @param now - Reference time.
 * @returns True only when a parseable date is in the past.
 */
export function isPastReviewTtl(reviewBy: string | null, now: Date): boolean {
  if (reviewBy === null) return false;
  const timestamp = Date.parse(reviewBy);
  return !Number.isNaN(timestamp) && timestamp < now.getTime();
}

/**
 * Build the provenance for a hit.
 *
 * The document's own owner wins over the zone's: a promoted document names the person
 * to route questions back to, while the zone owner is only a fallback.
 *
 * @param raw - Hit as the engine reported it.
 * @param zone - Zone that answered.
 * @param now - Reference time.
 * @param reviewBy - Review date from the document, when known.
 * @returns Provenance describing origin and trust.
 */
export function buildProvenance(
  raw: RawHit,
  zone: Zone,
  now: Date,
  reviewBy: string | null = null,
): Provenance {
  return {
    zone: zone.name,
    namespace: zone.namespace,
    tier: zone.tier,
    distance: zone.distance,
    owner: raw.owner ?? zone.owner,
    ageDays: ageInDays(raw.modified, now),
    pastReviewTtl: isPastReviewTtl(reviewBy, now),
  };
}

/**
 * Annotate a zone's results, preserving the order the engine returned them.
 *
 * Scores are left at zero here. Fusion assigns them once results from more than one
 * zone have to be compared, and a placeholder is more honest than an engine-native
 * score that cannot be compared across zones.
 *
 * @param rawHits - Results from one zone, in engine order.
 * @param zone - Zone that answered.
 * @param now - Reference time.
 * @returns Annotated hits, ranked one upward within the zone.
 */
export function annotate(rawHits: readonly RawHit[], zone: Zone, now: Date): Hit[] {
  return rawHits.map((raw, index) => ({
    documentId: raw.documentId,
    snippet: raw.snippet,
    rankWithinZone: index + 1,
    score: 0,
    provenance: buildProvenance(raw, zone, now),
    alsoIn: [],
    conflict: false,
    conflictWith: [],
  }));
}
