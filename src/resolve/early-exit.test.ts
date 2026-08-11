import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultConfig } from '../core/config.ts';
import type { Hit, ResolveRequest, Zone } from '../core/types.ts';
import { decideEarlyExit, topMargin } from './early-exit.ts';

const EARLY_EXIT = defaultConfig().earlyExit;

/** A ranked hit with an explicit score and age. */
function hit(documentId: string, score: number, ageDays: number | null = 1): Hit {
  return {
    documentId,
    snippet: 'text',
    rankWithinZone: 1,
    score,
    provenance: {
      zone: 'user',
      namespace: 'user',
      tier: 'USER',
      distance: 0,
      owner: null,
      ageDays,
      pastReviewTtl: false,
    },
    alsoIn: [],
    conflict: false,
    conflictWith: [],
  };
}

/** A zone with overridable fields. */
function zone(overrides: Partial<Zone> = {}): Zone {
  return {
    name: 'user',
    namespace: 'user',
    tier: 'USER',
    distance: 0,
    transport: { kind: 'stdio', command: 'x', args: [] },
    ttlSeconds: 0,
    halfLifeDays: 365,
    owner: null,
    sourceRepo: null,
    neverEarlyExit: false,
    delegatesTo: [],
    ...overrides,
  };
}

/** A request with overridable fields. */
function request(overrides: Partial<ResolveRequest> = {}): ResolveRequest {
  return { query: 'q', k: 10, mode: 'exact', scope: null, noEarlyExit: false, ...overrides };
}

test('topMargin is full for a single hit and zero without hits', () => {
  assert.equal(topMargin([hit('a.md', 1)]), 1);
  assert.equal(topMargin([]), 0);
  assert.equal(topMargin([hit('a.md', 0)]), 0, 'a zero-scoring top hit has no lead');
});

test('topMargin measures the relative lead of the top hit', () => {
  assert.equal(topMargin([hit('a.md', 1), hit('b.md', 0.5)]), 0.5);
  assert.equal(topMargin([hit('a.md', 1), hit('b.md', 0.9)]), 0.09999999999999998);
  assert.equal(topMargin([hit('a.md', 1), hit('b.md', 1)]), 0);
});

test('a clear, fresh top hit stops the walk', () => {
  const decision = decideEarlyExit(
    [hit('a.md', 1, 5), hit('b.md', 0.2, 5)],
    [zone()],
    request(),
    EARLY_EXIT,
  );

  assert.equal(decision.stop, true);
  assert.match(decision.reason, /5d old and leads by 0\.800/);
});

test('an ambiguous top hit does not stop the walk', () => {
  const decision = decideEarlyExit(
    [hit('a.md', 1, 5), hit('b.md', 0.95, 5)],
    [zone()],
    request(),
    EARLY_EXIT,
  );

  assert.equal(decision.stop, false);
  assert.match(decision.reason, /below marginMin/);
});

test('an old top hit does not stop the walk', () => {
  const decision = decideEarlyExit([hit('a.md', 1, 500)], [zone()], request(), EARLY_EXIT);

  assert.equal(decision.stop, false);
  assert.match(decision.reason, /500d old, beyond authoritativeMaxAgeDays 90/);
});

test('an undated top hit does not stop the walk', () => {
  const decision = decideEarlyExit([hit('a.md', 1, null)], [zone()], request(), EARLY_EXIT);

  assert.equal(decision.stop, false);
  assert.match(decision.reason, /no known age/);
});

test('too few hits does not stop the walk', () => {
  assert.equal(decideEarlyExit([], [zone()], request(), EARLY_EXIT).stop, false);
  assert.equal(
    decideEarlyExit([hit('a.md', 1, 5)], [zone()], request(), { ...EARLY_EXIT, minHits: 2 }).stop,
    false,
  );
});

test('each escape hatch forces the full walk', () => {
  const hits = [hit('a.md', 1, 5)];

  const disabled = decideEarlyExit(hits, [zone()], request({ noEarlyExit: true }), EARLY_EXIT);
  assert.equal(disabled.stop, false);
  assert.match(disabled.reason, /disabled by the caller/);

  const broad = decideEarlyExit(hits, [zone()], request({ mode: 'broad' }), EARLY_EXIT);
  assert.equal(broad.stop, false);
  assert.match(broad.reason, /broad mode/);

  const pinned = decideEarlyExit(hits, [zone({ neverEarlyExit: true })], request(), EARLY_EXIT);
  assert.equal(pinned.stop, false);
  assert.match(pinned.reason, /never stop the walk/);
});

test('thresholds are inclusive at the boundary', () => {
  const atAge = decideEarlyExit(
    [hit('a.md', 1, EARLY_EXIT.authoritativeMaxAgeDays)],
    [zone()],
    request(),
    EARLY_EXIT,
  );
  assert.equal(atAge.stop, true, 'exactly at the age limit still counts as fresh');

  const atMargin = decideEarlyExit(
    [hit('a.md', 1, 5), hit('b.md', 1 - EARLY_EXIT.marginMin, 5)],
    [zone()],
    request(),
    EARLY_EXIT,
  );
  assert.equal(atMargin.stop, true, 'exactly at the margin still counts as clear');
});
