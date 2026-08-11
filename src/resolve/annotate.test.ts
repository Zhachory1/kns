import test from 'node:test';
import assert from 'node:assert/strict';

import type { Zone } from '../core/types.ts';
import type { RawHit } from '../zone/client.ts';
import { ageInDays, annotate, buildProvenance, isPastReviewTtl } from './annotate.ts';

const NOW = new Date('2026-08-10T12:00:00.000Z');

/** A zone with overridable fields. */
function zone(overrides: Partial<Zone> = {}): Zone {
  return {
    name: 'team-platform',
    namespace: 'company/platform',
    tier: 'TEAM',
    distance: 1,
    transport: { kind: 'stdio', command: 'zbrain-mcp', args: [] },
    ttlSeconds: 3600,
    halfLifeDays: 180,
    owner: 'platform-team',
    sourceRepo: null,
    neverEarlyExit: false,
    ...overrides,
  };
}

/** A raw hit with overridable fields. */
function raw(overrides: Partial<RawHit> = {}): RawHit {
  return {
    documentId: 'a.md',
    snippet: 'text',
    score: 1,
    owner: null,
    modified: null,
    sourceVersion: null,
    ...overrides,
  };
}

test('ageInDays floors whole days and clamps future dates to zero', () => {
  assert.equal(ageInDays('2026-08-10T12:00:00.000Z', NOW), 0);
  assert.equal(ageInDays('2026-08-09T12:00:00.000Z', NOW), 1);
  assert.equal(ageInDays('2026-08-09T13:00:00.000Z', NOW), 0);
  assert.equal(ageInDays('2026-07-11T12:00:00.000Z', NOW), 30);
  assert.equal(ageInDays('2027-01-01T00:00:00.000Z', NOW), 0);
});

test('ageInDays returns null when there is no usable date', () => {
  assert.equal(ageInDays(null, NOW), null);
  assert.equal(ageInDays('not a date', NOW), null);
});

test('isPastReviewTtl is true only for a parseable past date', () => {
  assert.equal(isPastReviewTtl('2026-08-09T00:00:00.000Z', NOW), true);
  assert.equal(isPastReviewTtl('2027-01-01T00:00:00.000Z', NOW), false);
  assert.equal(isPastReviewTtl(null, NOW), false);
  assert.equal(isPastReviewTtl('whenever', NOW), false);
});

test("buildProvenance prefers the document's owner over the zone's", () => {
  const withDocumentOwner = buildProvenance(raw({ owner: 'author@example.com' }), zone(), NOW);
  assert.equal(withDocumentOwner.owner, 'author@example.com');

  const withZoneOwner = buildProvenance(raw(), zone(), NOW);
  assert.equal(withZoneOwner.owner, 'platform-team');

  const unowned = buildProvenance(raw(), zone({ owner: null }), NOW);
  assert.equal(unowned.owner, null);
});

test('buildProvenance carries the zone identity and routing distance', () => {
  const provenance = buildProvenance(raw({ modified: '2026-08-05T12:00:00.000Z' }), zone(), NOW);

  assert.equal(provenance.zone, 'team-platform');
  assert.equal(provenance.namespace, 'company/platform');
  assert.equal(provenance.tier, 'TEAM');
  assert.equal(provenance.distance, 1);
  assert.equal(provenance.ageDays, 5);
  assert.equal(provenance.pastReviewTtl, false);
});

test('buildProvenance marks a document past its review date', () => {
  const provenance = buildProvenance(raw(), zone(), NOW, '2026-01-01T00:00:00.000Z');
  assert.equal(provenance.pastReviewTtl, true);
});

test('annotate preserves engine order and ranks from one', () => {
  const hits = annotate([raw({ documentId: 'a.md' }), raw({ documentId: 'b.md' })], zone(), NOW);

  assert.deepEqual(
    hits.map((hit) => hit.documentId),
    ['a.md', 'b.md'],
  );
  assert.deepEqual(
    hits.map((hit) => hit.rankWithinZone),
    [1, 2],
  );
});

test('annotate leaves scoring to fusion', () => {
  const hits = annotate([raw({ score: 42 })], zone(), NOW);

  assert.equal(hits[0]?.score, 0, 'engine scores are not comparable across zones');
  assert.deepEqual(hits[0]?.alsoIn, []);
  assert.equal(hits[0]?.conflict, false);
});

test('annotate handles an empty result set', () => {
  assert.deepEqual(annotate([], zone(), NOW), []);
});
