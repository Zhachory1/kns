import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Hit } from '../core/types.ts';
import { CACHE_FILE, HitCache, cachePath } from './store.ts';

/** A minimal hit to cache. */
function hit(documentId: string): Hit {
  return {
    documentId,
    snippet: 'text',
    rankWithinZone: 1,
    score: 0.5,
    provenance: {
      zone: 'team',
      namespace: 'company/platform',
      tier: 'TEAM',
      distance: 1,
      owner: 'team',
      ageDays: 3,
      pastReviewTtl: false,
    },
    alsoIn: [],
    conflict: false,
  };
}

/** An in-memory cache. */
function cache(maxEntries?: number): HitCache {
  return new HitCache(':memory:', maxEntries);
}

test('cachePath sits inside the KNS home directory', () => {
  assert.equal(cachePath('/home/.kns'), path.join('/home/.kns', CACHE_FILE));
});

test('a stored entry is served back', (t) => {
  const store = cache();
  t.after(() => store.close());

  store.put('team', 'query', 10, 'gen-1', [hit('a.md')], 3600, 1000);
  const found = store.get('team', 'query', 10, 'gen-1', 3600, 2000);

  assert.equal(found?.length, 1);
  assert.equal(found?.[0]?.documentId, 'a.md');
  assert.equal(found?.[0]?.provenance.tier, 'TEAM');
});

test('a miss is reported as null', (t) => {
  const store = cache();
  t.after(() => store.close());

  assert.equal(store.get('team', 'never stored', 10, 'gen-1', 3600), null);
});

test('the key includes zone, query, and k', (t) => {
  const store = cache();
  t.after(() => store.close());

  store.put('team', 'query', 10, 'gen-1', [hit('a.md')], 3600, 1000);

  assert.equal(store.get('other', 'query', 10, 'gen-1', 3600, 1000), null);
  assert.equal(store.get('team', 'other query', 10, 'gen-1', 3600, 1000), null);
  assert.equal(store.get('team', 'query', 5, 'gen-1', 3600, 1000), null);
});

test('an entry expires once its TTL has passed', (t) => {
  const store = cache();
  t.after(() => store.close());

  store.put('team', 'query', 10, 'gen-1', [hit('a.md')], 60, 0);

  assert.ok(store.get('team', 'query', 10, 'gen-1', 60, 60_000), 'exactly at the TTL is still fresh');
  store.put('team', 'query', 10, 'gen-1', [hit('a.md')], 60, 0);
  assert.equal(store.get('team', 'query', 10, 'gen-1', 60, 60_001), null);
});

test('a generation change invalidates immediately, without waiting out the TTL', (t) => {
  const store = cache();
  t.after(() => store.close());

  store.put('team', 'query', 10, 'gen-1', [hit('a.md')], 3600, 1000);
  assert.equal(store.get('team', 'query', 10, 'gen-2', 3600, 1000), null);
  assert.equal(store.get('team', 'query', 10, 'gen-1', 3600, 1000), null, 'the stale row was dropped');
});

test('a zone with no TTL is never cached', (t) => {
  const store = cache();
  t.after(() => store.close());

  store.put('user', 'query', 10, 'gen-1', [hit('a.md')], 0, 1000);
  assert.equal(store.get('user', 'query', 10, 'gen-1', 0, 1000), null);
  assert.equal(store.stats().entries, 0);
});

test('a null generation is handled like any other version', (t) => {
  const store = cache();
  t.after(() => store.close());

  store.put('team', 'query', 10, null, [hit('a.md')], 3600, 1000);
  assert.ok(store.get('team', 'query', 10, null, 3600, 1000));
  assert.equal(store.get('team', 'query', 10, 'gen-1', 3600, 1000), null);
});

test('storing the same key twice replaces the entry', (t) => {
  const store = cache();
  t.after(() => store.close());

  store.put('team', 'query', 10, 'gen-1', [hit('a.md')], 3600, 1000);
  store.put('team', 'query', 10, 'gen-1', [hit('b.md')], 3600, 2000);

  const found = store.get('team', 'query', 10, 'gen-1', 3600, 2000);
  assert.equal(found?.length, 1);
  assert.equal(found?.[0]?.documentId, 'b.md');
  assert.equal(store.stats().entries, 1);
});

test('the cache evicts least-recently-used entries at the cap', (t) => {
  const store = cache(3);
  t.after(() => store.close());

  store.put('team', 'q1', 10, 'g', [hit('1.md')], 3600, 1000);
  store.put('team', 'q2', 10, 'g', [hit('2.md')], 3600, 2000);
  store.put('team', 'q3', 10, 'g', [hit('3.md')], 3600, 3000);

  // Touch q1 so that q2 becomes the least recently used.
  store.get('team', 'q1', 10, 'g', 3600, 4000);
  store.put('team', 'q4', 10, 'g', [hit('4.md')], 3600, 5000);

  assert.equal(store.stats().entries, 3);
  assert.ok(store.get('team', 'q1', 10, 'g', 3600, 6000), 'recently used entry survives');
  assert.equal(store.get('team', 'q2', 10, 'g', 3600, 6000), null, 'least recently used was evicted');
});

test('purge removes one zone or everything', (t) => {
  const store = cache();
  t.after(() => store.close());

  store.put('team', 'q', 10, 'g', [hit('a.md')], 3600, 1000);
  store.put('company', 'q', 10, 'g', [hit('b.md')], 3600, 1000);

  assert.equal(store.purge('team'), 1);
  assert.equal(store.stats().entries, 1);
  assert.equal(store.purge(), 1);
  assert.equal(store.stats().entries, 0);
  assert.equal(store.purge(), 0);
});

test('stats report per-zone counts and this process hit rate', (t) => {
  const store = cache();
  t.after(() => store.close());

  store.put('team', 'q', 10, 'g', [hit('a.md')], 3600, 1000);
  store.put('company', 'q', 10, 'g', [hit('b.md')], 3600, 1000);

  store.get('team', 'q', 10, 'g', 3600, 1000);
  store.get('team', 'absent', 10, 'g', 3600, 1000);

  const stats = store.stats();
  assert.equal(stats.entries, 2);
  assert.deepEqual(stats.byZone, { company: 1, team: 1 });
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 1);
});

test('a corrupt cache file is rebuilt rather than fatal', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'kns-cache-'));
  const file = cachePath(home);
  await writeFile(file, 'this is definitely not a sqlite database', 'utf8');

  const store = new HitCache(file);
  store.put('team', 'q', 10, 'g', [hit('a.md')], 3600, 1000);
  assert.equal(store.stats().entries, 1);
  store.close();
});

test('a cache file survives being reopened', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'kns-cache-'));
  const file = cachePath(home);

  const first = new HitCache(file);
  first.put('team', 'q', 10, 'g', [hit('a.md')], 3600, 1000);
  first.close();

  const second = new HitCache(file);
  assert.ok(second.get('team', 'q', 10, 'g', 3600, 2000));
  second.close();
});

test('unreadable cached content is treated as a miss, not a crash', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'kns-cache-'));
  const file = cachePath(home);

  const store = new HitCache(file);
  store.put('team', 'q', 10, 'g', [hit('a.md')], 3600, 1000);
  store.close();

  // Corrupt one row's payload behind the store's back.
  const raw = new DatabaseSync(file);
  raw.prepare('UPDATE zone_results SET hits = ?').run('{not json');
  raw.close();

  const reopened = new HitCache(file);
  assert.equal(reopened.get('team', 'q', 10, 'g', 3600, 2000), null);
  assert.equal(reopened.stats().misses, 1);
  reopened.close();
});
