import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultConfig } from '../core/config.ts';
import type { Hit, Tier, Zone } from '../core/types.ts';
import {
  authority,
  coverage,
  compareHits,
  dedupe,
  freshness,
  nearness,
  rankHits,
  rrf,
  scoreHit,
} from './rank.ts';

const RANKING = defaultConfig().ranking;

/** A hit with overridable provenance. */
function hit(
  documentId: string,
  options: {
    rank?: number;
    zone?: string;
    tier?: Tier;
    distance?: number;
    ageDays?: number | null;
    owner?: string | null;
    pastReviewTtl?: boolean;
    snippet?: string;
    score?: number;
  } = {},
): Hit {
  return {
    documentId,
    snippet: options.snippet ?? `snippet ${documentId}`,
    rankWithinZone: options.rank ?? 1,
    score: options.score ?? 0,
    provenance: {
      zone: options.zone ?? 'user',
      namespace: 'user',
      tier: options.tier ?? 'USER',
      distance: options.distance ?? 0,
      owner: options.owner ?? null,
      ageDays: options.ageDays ?? null,
      pastReviewTtl: options.pastReviewTtl ?? false,
    },
    alsoIn: [],
    conflict: false,
  };
}

/** A zone map for rankHits. */
function zones(entries: { name: string; halfLifeDays: number }[]): Map<string, Zone> {
  return new Map(
    entries.map((entry) => [
      entry.name,
      {
        name: entry.name,
        namespace: 'x',
        tier: 'TEAM',
        distance: 1,
        transport: { kind: 'stdio', command: 'x', args: [] },
        ttlSeconds: 0,
        halfLifeDays: entry.halfLifeDays,
        owner: null,
        sourceRepo: null,
        neverEarlyExit: false,
      } satisfies Zone,
    ]),
  );
}

test('rrf decreases with rank and stays within (0, 1]', () => {
  assert.ok(rrf(1, 60) > rrf(2, 60));
  assert.ok(rrf(2, 60) > rrf(10, 60));
  assert.ok(rrf(1, 60) > 0 && rrf(1, 60) <= 1);
  assert.equal(rrf(0, 60), rrf(1, 60), 'ranks below one are clamped');
});

test('rrfK flattens differences between adjacent ranks', () => {
  const sharp = rrf(1, 1) - rrf(2, 1);
  const flat = rrf(1, 1000) - rrf(2, 1000);
  assert.ok(sharp > flat);
});

test('nearness decays with distance and never rewards it', () => {
  assert.equal(nearness(0, 0.9), 1);
  assert.ok(Math.abs(nearness(1, 0.9) - 0.9) < 1e-12);
  assert.ok(Math.abs(nearness(2, 0.9) - 0.81) < 1e-12);
  assert.equal(nearness(-3, 0.9), 1, 'negative distance is clamped');
});

test('freshness decays with age and is neutral when age is unknown', () => {
  assert.equal(freshness(null, 180), 1);
  assert.equal(freshness(0, 180), 1);
  assert.ok(freshness(180, 180) < freshness(90, 180));
  assert.ok(Math.abs(freshness(180, 180) - Math.exp(-1)) < 1e-12);
  assert.equal(freshness(-5, 180), 1, 'negative age is clamped');
});

test('authority exempts the private tier', () => {
  assert.equal(authority(hit('a.md', { tier: 'USER', owner: null }), RANKING), 1);
  assert.equal(authority(hit('a.md', { tier: 'USER', pastReviewTtl: true }), RANKING), 1);
});

test('authority penalises unowned and stale shared documents', () => {
  const owned = authority(hit('a.md', { tier: 'TEAM', owner: 'team' }), RANKING);
  const unowned = authority(hit('a.md', { tier: 'TEAM', owner: null }), RANKING);
  const stale = authority(hit('a.md', { tier: 'TEAM', owner: 'team', pastReviewTtl: true }), RANKING);
  const both = authority(hit('a.md', { tier: 'TEAM', owner: null, pastReviewTtl: true }), RANKING);

  assert.equal(owned, 1);
  assert.equal(unowned, RANKING.unownedPenalty);
  assert.equal(stale, RANKING.staleFactor);
  assert.ok(both < unowned && both < stale);
});

test('scoreHit is monotonic in rank', () => {
  const zone = { halfLifeDays: 180 } as Zone;
  const first = scoreHit(hit('a.md', { rank: 1 }), zone, RANKING);
  const second = scoreHit(hit('a.md', { rank: 2 }), zone, RANKING);
  const tenth = scoreHit(hit('a.md', { rank: 10 }), zone, RANKING);

  assert.ok(first > second && second > tenth);
});

test('scoreHit is monotonic in freshness', () => {
  const zone = { halfLifeDays: 180 } as Zone;
  const fresh = scoreHit(hit('a.md', { ageDays: 1 }), zone, RANKING);
  const old = scoreHit(hit('a.md', { ageDays: 400 }), zone, RANKING);

  assert.ok(fresh > old);
});

test('scoreHit never produces NaN or Infinity on edge inputs', () => {
  const zone = { halfLifeDays: 0.5 } as Zone;
  const cases = [
    hit('a.md', { rank: 0, ageDays: 0 }),
    hit('a.md', { rank: 1, ageDays: 100_000 }),
    hit('a.md', { rank: 10_000, ageDays: null }),
    hit('a.md', { tier: 'COMPANY', distance: 40, ageDays: 1 }),
  ];

  for (const candidate of cases) {
    const score = scoreHit(candidate, zone, RANKING);
    assert.ok(Number.isFinite(score), `score was ${score}`);
    assert.ok(score >= 0);
  }
});

test('nearness is a prior, not an override', () => {
  const zone = { halfLifeDays: 180 } as Zone;
  const weakLocal = scoreHit(hit('local.md', { rank: 9, tier: 'USER', distance: 0 }), zone, RANKING);
  const strongCompany = scoreHit(
    hit('company.md', { rank: 1, tier: 'COMPANY', distance: 2, owner: 'team', ageDays: 1 }),
    zone,
    RANKING,
  );

  assert.ok(
    strongCompany > weakLocal,
    'a fresh, owned, top-ranked company document must be able to beat a weak local note',
  );
});

test('a fresh team document beats a stale company document', () => {
  const ranked = rankHits(
    [
      hit('topic.md', { zone: 'company', tier: 'COMPANY', distance: 2, rank: 1, ageDays: 900, owner: 'eng', snippet: 'old' }),
      hit('other.md', { zone: 'team', tier: 'TEAM', distance: 1, rank: 1, ageDays: 3, owner: 'team', snippet: 'new' }),
    ],
    zones([
      { name: 'company', halfLifeDays: 365 },
      { name: 'team', halfLifeDays: 180 },
    ]),
    RANKING,
  );

  assert.equal(ranked[0]?.documentId, 'other.md');
});

test('compareHits breaks ties deterministically', () => {
  const a = { ...hit('b.md', { distance: 1 }), score: 1 };
  const b = { ...hit('a.md', { distance: 1 }), score: 1 };
  const nearer = { ...hit('z.md', { distance: 0 }), score: 1 };

  assert.ok(compareHits(a, b) > 0, 'equal score and distance falls back to document id');
  assert.ok(compareHits(nearer, a) < 0, 'equal score falls back to distance');
  assert.ok(compareHits({ ...a, score: 2 }, b) < 0);
});

test('dedupe keeps the best copy and records the others', () => {
  const winner = { ...hit('shared.md', { zone: 'team', distance: 1 }), score: 5 };
  const loser = { ...hit('shared.md', { zone: 'company', distance: 2 }), score: 1 };

  const [merged] = dedupe([loser, winner]);

  assert.equal(merged?.provenance.zone, 'team');
  assert.deepEqual(merged?.alsoIn, ['company']);
  assert.equal(merged?.conflict, false, 'identical snippets are not a conflict');
});

test('dedupe flags copies whose content disagrees', () => {
  const fresh = { ...hit('shared.md', { zone: 'team', snippet: 'new text' }), score: 5 };
  const stale = { ...hit('shared.md', { zone: 'company', snippet: 'old text' }), score: 1 };

  const [merged] = dedupe([fresh, stale]);

  assert.equal(merged?.conflict, true);
  assert.deepEqual(merged?.alsoIn, ['company']);
});

test('dedupe leaves distinct documents alone', () => {
  const merged = dedupe([hit('a.md'), hit('b.md')]);

  assert.equal(merged.length, 2);
  assert.ok(merged.every((entry) => entry.alsoIn.length === 0 && !entry.conflict));
});

test('rankHits is invariant under permutation of its input', () => {
  const input = [
    hit('a.md', { zone: 'user', rank: 2 }),
    hit('b.md', { zone: 'team', tier: 'TEAM', distance: 1, rank: 1, owner: 'team', ageDays: 10 }),
    hit('c.md', { zone: 'company', tier: 'COMPANY', distance: 2, rank: 1, owner: 'eng', ageDays: 400 }),
  ];
  const map = zones([
    { name: 'user', halfLifeDays: 3650 },
    { name: 'team', halfLifeDays: 180 },
    { name: 'company', halfLifeDays: 365 },
  ]);

  const forward = rankHits(input, map, RANKING).map((entry) => entry.documentId);
  const reversed = rankHits([...input].reverse(), map, RANKING).map((entry) => entry.documentId);
  const shuffled = rankHits([input[2]!, input[0]!, input[1]!], map, RANKING).map((entry) => entry.documentId);

  assert.deepEqual(reversed, forward);
  assert.deepEqual(shuffled, forward);
});

test('rankHits is stable across repeated runs', () => {
  const input = Array.from({ length: 10 }, (_unused, index) =>
    hit(`doc-${index}.md`, { rank: (index % 3) + 1, distance: index % 2 }),
  );
  const map = zones([{ name: 'user', halfLifeDays: 365 }]);

  const first = rankHits(input, map, RANKING).map((entry) => entry.documentId);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.deepEqual(rankHits(input, map, RANKING).map((entry) => entry.documentId), first);
  }
});

test('rankHits falls back to a default half-life for an unknown zone', () => {
  const ranked = rankHits([hit('a.md', { zone: 'missing', ageDays: 10 })], new Map(), RANKING);

  assert.equal(ranked.length, 1);
  assert.ok(Number.isFinite(ranked[0]?.score ?? Number.NaN));
  assert.ok((ranked[0]?.score ?? 0) > 0);
});

test('rankHits handles an empty input', () => {
  assert.deepEqual(rankHits([], new Map(), RANKING), []);
});

test('coverage measures how much of the query the snippet contains', () => {
  assert.equal(coverage('index reload', 'index reload procedure'), 1);
  assert.equal(coverage('index reload', 'index only'), 0.5);
  assert.equal(coverage('index reload', 'nothing relevant'), 0);
  assert.equal(coverage('', 'anything'), 1, 'a query with no terms cannot discriminate');
  assert.equal(coverage('Index RELOAD', 'index reload'), 1, 'matching is case-insensitive');
});

test('coverage restores the magnitude that rank fusion discards', () => {
  const zone = { halfLifeDays: 180 } as Zone;
  const query = 'data retention policy deletion schedule';

  // Both are rank 1 in their own zone, which is all RRF can see. Zones hold disjoint
  // corpora, so without coverage a zone with one weak match ties with the zone that
  // actually holds the answer.
  const weakLocal = scoreHit(
    hit('scratch.md', { rank: 1, tier: 'USER', distance: 0, snippet: 'retention something later' }),
    zone,
    RANKING,
    query,
  );
  const strongCompany = scoreHit(
    hit('policy.md', {
      rank: 1,
      tier: 'COMPANY',
      distance: 2,
      owner: 'eng',
      ageDays: 9,
      snippet: 'data retention policy ninety days deletion schedule',
    }),
    zone,
    RANKING,
    query,
  );

  assert.ok(strongCompany > weakLocal);
});

test('the coverage floor keeps a terse snippet from being zeroed out', () => {
  const zone = { halfLifeDays: 180 } as Zone;
  const score = scoreHit(hit('a.md', { snippet: 'a title with nothing in common' }), zone, RANKING, 'zzz qqq');

  assert.ok(score > 0);
});
