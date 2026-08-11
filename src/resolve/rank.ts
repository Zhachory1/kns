/**
 * Cross-zone ranking.
 *
 * Zones run different engines, so their scores are not comparable: a BM25 score and a
 * cosine similarity live on different scales, and even two BM25 indexes over
 * different corpora do not agree. Ranking on *rank* instead of score sidesteps the
 * whole calibration problem, which is why this module uses Reciprocal Rank Fusion and
 * then applies priors it can actually justify.
 *
 * @module
 */

import type { RankingConfig } from '../core/config.ts';
import type { Hit, Zone } from '../core/types.ts';

/**
 * Fraction of the query's terms that appear in a hit's snippet.
 *
 * RRF assumes every ranker ranks the same corpus. Zones do not: their corpora are
 * disjoint, so "rank 1 in the local zone" and "rank 1 in the company zone" are not
 * comparable, and a zone holding one weak match ties with a zone holding the exact
 * answer. Coverage restores the magnitude that fusion throws away, and it does so
 * without trusting any engine's score — KNS computes it uniformly from the text every
 * zone returns.
 *
 * @param query - The query text.
 * @param snippet - The snippet the zone returned.
 * @returns A value in [0, 1]. A query with no usable terms scores 1.
 */
export function coverage(query: string, snippet: string): number {
  const terms = new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  if (terms.size === 0) return 1;

  const present = new Set(snippet.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  let matched = 0;
  for (const term of terms) {
    if (present.has(term)) matched += 1;
  }
  return matched / terms.size;
}

/**
 * Reciprocal Rank Fusion term.
 *
 * @param rankWithinZone - One-based rank the zone assigned.
 * @param rrfK - Fusion constant; larger values flatten differences between ranks.
 * @returns The fusion contribution, in (0, 1].
 */
export function rrf(rankWithinZone: number, rrfK: number): number {
  return 1 / (rrfK + Math.max(1, rankWithinZone));
}

/**
 * Nearness prior.
 *
 * A mild prior, not an override: a fresh, owned, top-ranked company document should
 * be able to beat a weak local note, otherwise the hierarchy is just a slower
 * local-only search.
 *
 * @param distance - Routing distance of the zone that answered.
 * @param base - Per-step multiplier, below one.
 * @returns The prior, in (0, 1].
 */
export function nearness(distance: number, base: number): number {
  return base ** Math.max(0, distance);
}

/**
 * Freshness decay.
 *
 * An unknown age is treated as neutral. Penalising undated documents would mostly
 * punish engines that do not report dates, which says nothing about the content.
 *
 * @param ageDays - Age in days, or null when unknown.
 * @param halfLifeDays - Zone half-life; larger values decay more slowly.
 * @returns The decay factor, in (0, 1].
 */
export function freshness(ageDays: number | null, halfLifeDays: number): number {
  if (ageDays === null) return 1;
  return Math.exp(-Math.max(0, ageDays) / Math.max(0.5, halfLifeDays));
}

/**
 * Authority factor.
 *
 * Applies only to shared zones. A private document has exactly one owner — the person
 * reading it — so penalising an unowned local note would be nonsense.
 *
 * @param hit - Annotated hit.
 * @param config - Ranking weights.
 * @returns The factor, in (0, 1].
 */
export function authority(hit: Hit, config: RankingConfig): number {
  if (hit.provenance.tier === 'USER') return 1;

  const owned = hit.provenance.owner === null ? config.unownedPenalty : 1;
  const stale = hit.provenance.pastReviewTtl ? config.staleFactor : 1;
  return owned * stale;
}

/**
 * Score one hit.
 *
 * @param hit - Annotated hit.
 * @param zone - Zone that produced it, for its half-life.
 * @param config - Ranking weights.
 * @returns The fused score. Comparable within one response only.
 */
export function scoreHit(hit: Hit, zone: Zone, config: RankingConfig, query = ''): number {
  // The floor keeps coverage from zeroing out a hit whose snippet simply does not
  // repeat the query — a summary line, or an engine that returns a title.
  const covered = Math.max(config.coverageFloor, coverage(query, hit.snippet));

  return (
    rrf(hit.rankWithinZone, config.rrfK) *
    covered *
    nearness(hit.provenance.distance, config.nearnessBase) *
    freshness(hit.provenance.ageDays, zone.halfLifeDays) *
    authority(hit, config)
  );
}

/**
 * Order hits deterministically.
 *
 * Ties break on distance and then document id, so identical inputs always produce an
 * identical response. Non-determinism here would make every downstream test flaky and
 * every user report unreproducible.
 *
 * @param left - First hit.
 * @param right - Second hit.
 * @returns Standard comparator result.
 */
export function compareHits(left: Hit, right: Hit): number {
  if (right.score !== left.score) return right.score - left.score;
  if (left.provenance.distance !== right.provenance.distance) {
    return left.provenance.distance - right.provenance.distance;
  }
  return left.documentId.localeCompare(right.documentId);
}

/**
 * Collapse the same document returned by more than one zone.
 *
 * The best-scoring copy wins and records the others in `alsoIn`. When the copies
 * disagree on content, the survivor is marked `conflict` — surfacing the
 * disagreement is more useful than silently picking a side, because the reader is the
 * one who can tell which is right and who to ask.
 *
 * @param hits - Scored hits.
 * @returns One hit per document, in input order of first appearance.
 */
export function dedupe(hits: readonly Hit[]): Hit[] {
  const best = new Map<string, Hit>();
  const others = new Map<string, string[]>();
  const conflicting = new Set<string>();

  for (const hit of hits) {
    const existing = best.get(hit.documentId);
    if (existing === undefined) {
      best.set(hit.documentId, hit);
      others.set(hit.documentId, []);
      continue;
    }

    if (existing.snippet !== hit.snippet) conflicting.add(hit.documentId);

    const loser = compareHits(existing, hit) <= 0 ? hit : existing;
    const winner = loser === hit ? existing : hit;
    best.set(hit.documentId, winner);
    others.get(hit.documentId)?.push(loser.provenance.zone);
  }

  return [...best.values()].map((hit) => ({
    ...hit,
    alsoIn: others.get(hit.documentId) ?? [],
    conflict: conflicting.has(hit.documentId),
  }));
}

/**
 * Score, deduplicate, and order hits from any number of zones.
 *
 * @param hits - Annotated hits from every zone queried.
 * @param zones - Zones by name, for per-zone half-life.
 * @param config - Ranking weights.
 * @param query - Query text, used for the coverage factor.
 * @returns Ranked hits, best first.
 */
export function rankHits(
  hits: readonly Hit[],
  zones: ReadonlyMap<string, Zone>,
  config: RankingConfig,
  query = '',
): Hit[] {
  const scored = hits.map((hit) => {
    const zone = zones.get(hit.provenance.zone);
    const halfLife = zone?.halfLifeDays ?? 365;
    return {
      ...hit,
      score: scoreHit(hit, { halfLifeDays: halfLife } as Zone, config, query),
    };
  });

  return dedupe(scored).sort(compareHits);
}
