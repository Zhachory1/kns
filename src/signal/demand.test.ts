import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  BUCKETS,
  DEFAULT_K_MIN,
  DemandStore,
  aggregate,
  bucketFor,
  isoWeek,
  reporterId,
} from './demand.ts';
import type { DemandReport } from './demand.ts';

const NOW = new Date('2026-08-10T12:00:00.000Z');

/** An in-memory store. */
function store(): DemandStore {
  return new DemandStore(':memory:');
}

test('isoWeek is stable within a week and changes between weeks', () => {
  assert.equal(isoWeek(new Date('2026-08-10T00:00:00.000Z')), isoWeek(new Date('2026-08-14T23:59:00.000Z')));
  assert.notEqual(isoWeek(new Date('2026-08-10T00:00:00.000Z')), isoWeek(new Date('2026-08-20T00:00:00.000Z')));
  assert.match(isoWeek(NOW), /^\d{4}-W\d{2}$/);
});

test('counts are bucketed at the documented boundaries', () => {
  assert.equal(bucketFor(1), '1-2');
  assert.equal(bucketFor(2), '1-2');
  assert.equal(bucketFor(3), '3-5');
  assert.equal(bucketFor(5), '3-5');
  assert.equal(bucketFor(6), '6-10');
  assert.equal(bucketFor(10), '6-10');
  assert.equal(bucketFor(11), '10+');
  assert.equal(bucketFor(10_000), '10+');
  assert.deepEqual([...BUCKETS], ['1-2', '3-5', '6-10', '10+']);
});

test('the reporter id rotates with the period and depends on the local secret', () => {
  assert.equal(reporterId('secret', '2026-W33'), reporterId('secret', '2026-W33'));
  assert.notEqual(reporterId('secret', '2026-W33'), reporterId('secret', '2026-W34'));
  assert.notEqual(reporterId('secret', '2026-W33'), reporterId('other', '2026-W33'));
  assert.match(reporterId('secret', '2026-W33'), /^[0-9a-f]{16}$/);
});

test('the reporter id does not reveal the secret', () => {
  assert.ok(!reporterId('my-machine-secret', '2026-W33').includes('secret'));
});

test('records accumulate per document and week', (t) => {
  const demand = store();
  t.after(() => demand.close());

  demand.record('team', 'a.md', NOW);
  demand.record('team', 'a.md', NOW);
  demand.record('team', 'b.md', NOW);
  demand.record('team', 'a.md', new Date('2026-08-20T00:00:00.000Z'));

  const rows = demand.rows();
  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.documentId, 'a.md');
  assert.equal(rows[0]?.count, 2);
});

test('rows can be filtered to one week', (t) => {
  const demand = store();
  t.after(() => demand.close());

  demand.record('team', 'a.md', NOW);
  demand.record('team', 'b.md', new Date('2026-08-20T00:00:00.000Z'));

  assert.equal(demand.rows(isoWeek(NOW)).length, 1);
});

test('counts by document sum across zones and weeks', (t) => {
  const demand = store();
  t.after(() => demand.close());

  demand.record('team', 'a.md', NOW);
  demand.record('company', 'a.md', NOW);
  demand.record('team', 'a.md', new Date('2026-08-20T00:00:00.000Z'));

  assert.deepEqual(demand.countsByDocument(), { 'a.md': 3 });
});

test('the schema has nowhere to put a query', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'kns-demand-'));
  const file = path.join(home, 'cache.sqlite');

  const demand = new DemandStore(file);
  demand.record('team', 'a.md', NOW);
  demand.close();

  const raw = new DatabaseSync(file);
  const columns = (raw.prepare('PRAGMA table_info(demand)').all() as { name: string }[]).map((row) => row.name);
  raw.close();

  assert.deepEqual(columns, ['zone', 'document_id', 'week', 'count']);
  for (const forbidden of ['query', 'text', 'user', 'who', 'terms']) {
    assert.ok(!columns.includes(forbidden), `schema exposes a ${forbidden} column`);
  }
});

test('no query text reaches the database file', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'kns-demand-'));
  const file = path.join(home, 'cache.sqlite');

  const demand = new DemandStore(file);
  demand.record('team', 'a.md', NOW);
  demand.close();

  const contents = await readFile(file, 'utf8').catch(() => '');
  assert.ok(!contents.includes('what did we decide about'), 'a query must never be persisted');
});

test('an export is bucketed and pseudonymous', (t) => {
  const demand = store();
  t.after(() => demand.close());

  for (let i = 0; i < 7; i += 1) demand.record('team', 'a.md', NOW);

  const reports = demand.buildExport('machine-secret', isoWeek(NOW));
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.bucket, '6-10', 'the exact count is never exported');
  assert.equal(reports[0]?.reporter, reporterId('machine-secret', isoWeek(NOW)));
  assert.ok(!JSON.stringify(reports).includes('"count"'));
});

test('aggregation drops anything below the k-anonymity threshold', () => {
  const week = '2026-W33';
  const reports: DemandReport[] = Array.from({ length: DEFAULT_K_MIN }, (_unused, index) => ({
    zone: 'team',
    documentId: 'popular.md',
    week,
    bucket: '3-5',
    reporter: `reporter-${index}`,
  }));
  reports.push({ zone: 'team', documentId: 'lonely.md', week, bucket: '1-2', reporter: 'reporter-0' });

  const aggregated = aggregate(reports);

  assert.deepEqual(
    aggregated.map((entry) => entry.documentId),
    ['popular.md'],
  );
  assert.equal(aggregated[0]?.reporters, DEFAULT_K_MIN);
});

test('repeated reports from one machine do not clear the threshold', () => {
  const reports: DemandReport[] = Array.from({ length: 20 }, () => ({
    zone: 'team',
    documentId: 'a.md',
    week: '2026-W33',
    bucket: '10+',
    reporter: 'the-same-machine',
  }));

  assert.deepEqual(aggregate(reports), [], 'one person reporting twenty times is still one person');
});

test('the threshold is configurable and aggregation is deterministic', () => {
  const reports: DemandReport[] = [
    { zone: 'team', documentId: 'b.md', week: 'w', bucket: '1-2', reporter: 'r1' },
    { zone: 'team', documentId: 'b.md', week: 'w', bucket: '1-2', reporter: 'r2' },
    { zone: 'team', documentId: 'a.md', week: 'w', bucket: '1-2', reporter: 'r1' },
    { zone: 'team', documentId: 'a.md', week: 'w', bucket: '1-2', reporter: 'r2' },
  ];

  const aggregated = aggregate(reports, 2);
  assert.deepEqual(
    aggregated.map((entry) => entry.documentId),
    ['a.md', 'b.md'],
    'ties order by document id so the output is reproducible',
  );
  assert.deepEqual(aggregate(reports, 3), []);
});

test('purge clears every counter', (t) => {
  const demand = store();
  t.after(() => demand.close());

  demand.record('team', 'a.md', NOW);
  demand.record('team', 'b.md', NOW);

  assert.equal(demand.purge(), 2);
  assert.deepEqual(demand.rows(), []);
});
