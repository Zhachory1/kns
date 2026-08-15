import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { KnsError } from '../core/errors.ts';
import type { Zone } from '../core/types.ts';
import { StdioZoneClient, decodeToolResult, toRawHits } from './client.ts';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const fakeServer = path.join(root, 'fixtures', 'fake-zone', 'server.mjs');

/** A zone pointing at the controllable fake server in a given mode. */
function fakeZone(mode: string, overrides: Partial<Zone> = {}): Zone {
  return {
    name: `fake-${mode}`,
    namespace: 'user',
    tier: 'USER',
    distance: 0,
    transport: { kind: 'stdio', command: process.execPath, args: [fakeServer, '--mode', mode] },
    ttlSeconds: 0,
    halfLifeDays: 365,
    owner: null,
    sourceRepo: null,
    neverEarlyExit: false,
    ...overrides,
  };
}

/** Count live child processes matching the fake server, for leak assertions. */
function fakeServerCount(): number {
  try {
    const output = execFileSync('/bin/sh', ['-c', `pgrep -f "${fakeServer}" | wc -l`], {
      encoding: 'utf8',
    });
    return Number(output.trim());
  } catch {
    return 0;
  }
}

test('toRawHits reads several field spellings and skips unusable entries', () => {
  const hits = toRawHits({
    results: [
      { documentId: 'a.md', snippet: 'A', score: 2, owner: 'me', modified: '2026-01-01', sourceVersion: 'v1' },
      { id: 'b.md', excerpt: 'B', relevance: 1.5, hash: 'h2' },
      { path: 'c.md' },
      { missingAnIdentifier: true },
      'not an object',
      null,
    ],
  });

  assert.deepEqual(
    hits.map((hit) => hit.documentId),
    ['a.md', 'b.md', 'c.md'],
  );
  assert.equal(hits[1]?.snippet, 'B');
  assert.equal(hits[1]?.score, 1.5);
  assert.equal(hits[1]?.sourceVersion, 'h2');
  assert.equal(hits[2]?.snippet, '');
  assert.equal(hits[2]?.score, null);
  assert.equal(hits[2]?.owner, null);
});

test('toRawHits accepts hits, documents, or a bare array, and tolerates junk', () => {
  assert.equal(toRawHits({ hits: [{ id: 'a.md' }] }).length, 1);
  assert.equal(toRawHits({ documents: [{ id: 'a.md' }] }).length, 1);
  assert.equal(toRawHits([{ id: 'a.md' }]).length, 1);
  assert.deepEqual(toRawHits({ results: 'nope' }), []);
  assert.deepEqual(toRawHits(null), []);
  assert.deepEqual(toRawHits(42), []);
});

test('decodeToolResult unwraps a content block, JSON or plain text', () => {
  assert.deepEqual(decodeToolResult({ content: [{ type: 'text', text: '{"a":1}' }] }), { a: 1 });
  assert.equal(decodeToolResult({ content: [{ type: 'text', text: 'plain' }] }), 'plain');
  assert.deepEqual(decodeToolResult({ content: [] }), { content: [] });
  assert.deepEqual(decodeToolResult({ content: [null, { type: 'image' }] }), {
    content: [null, { type: 'image' }],
  });
  assert.equal(decodeToolResult('raw'), 'raw');
  assert.equal(decodeToolResult(null), null);
});

test('a healthy zone answers search, get, and status', async (t) => {
  const client = new StdioZoneClient(fakeZone('ok'));
  t.after(() => client.close());

  const hits = await client.search('index reload', 5, 4000);
  assert.equal(hits.length, 2, 'the malformed third result is dropped');
  assert.equal(hits[0]?.documentId, 'concepts/hot-index-reload.md');
  assert.equal(hits[0]?.owner, 'me@example.com');
  assert.equal(hits[0]?.sourceVersion, 'abc123');

  assert.equal(await client.get('concepts/hot-index-reload.md', 1, 5, 4000), 'excerpt line one');

  const status = await client.status(4000);
  assert.equal(status.documents, 42);
  assert.equal(status.generation, 'gen-7');
});

test('the client reuses one child process across calls', async (t) => {
  const client = new StdioZoneClient(fakeZone('ok'));
  t.after(() => client.close());

  const before = fakeServerCount();
  await client.search('one', 5, 4000);
  await client.search('two', 5, 4000);
  const after = fakeServerCount();

  assert.ok(after - before <= 1, `expected at most one child, saw ${after - before}`);
});

test('a zone using newline framing works identically', async (t) => {
  const client = new StdioZoneClient(fakeZone('newline'));
  t.after(() => client.close());

  const hits = await client.search('q', 5, 4000);
  assert.equal(hits[0]?.documentId, 'concepts/hot-index-reload.md');
});

test('noise on stdout does not poison well-formed traffic', async (t) => {
  const client = new StdioZoneClient(fakeZone('garbage'));
  t.after(() => client.close());

  const hits = await client.search('q', 5, 4000);
  assert.equal(hits.length, 2);
});

test('an empty result set is not an error', async (t) => {
  const client = new StdioZoneClient(fakeZone('empty'));
  t.after(() => client.close());

  assert.deepEqual(await client.search('q', 5, 4000), []);
});

test('a JSON-RPC error becomes zone_unavailable', async (t) => {
  const client = new StdioZoneClient(fakeZone('error'));
  t.after(() => client.close());

  await assert.rejects(
    () => client.search('q', 5, 4000),
    (error: unknown) =>
      error instanceof KnsError && error.code === 'zone_unavailable' && /zone said no/.test(error.message),
  );
});

test('a slow zone times out, is reclaimed, and leaves no child behind', async (t) => {
  const client = new StdioZoneClient(fakeZone('slow'));
  t.after(() => client.close());

  const before = fakeServerCount();
  await assert.rejects(
    () => client.search('q', 5, 150),
    (error: unknown) =>
      error instanceof KnsError && error.code === 'zone_timeout' && error.retryable === true,
  );

  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(fakeServerCount() <= before, 'the timed-out child must not survive');
});

test('a zone that never completes the handshake times out', async (t) => {
  const client = new StdioZoneClient(fakeZone('deaf'));
  t.after(() => client.close());

  await assert.rejects(
    () => client.search('q', 5, 200),
    (error: unknown) => error instanceof KnsError && error.code === 'zone_timeout',
  );
});

test('a zone that exits during a call fails with zone_unavailable', async (t) => {
  const client = new StdioZoneClient(fakeZone('die'));
  t.after(() => client.close());

  await assert.rejects(
    async () => {
      await client.search('q', 5, 4000);
      await new Promise((resolve) => setTimeout(resolve, 60));
      await client.search('q', 5, 4000);
    },
    (error: unknown) => error instanceof KnsError && error.code === 'zone_unavailable',
  );
});

test('a zone that exits immediately fails with zone_unavailable', async (t) => {
  const client = new StdioZoneClient(fakeZone('crash'));
  t.after(() => client.close());

  await assert.rejects(
    () => client.search('q', 5, 3000),
    (error: unknown) => error instanceof KnsError && error.code === 'zone_unavailable',
  );
});

test('an unspawnable command fails with zone_unavailable', async (t) => {
  const zone = fakeZone('ok', {
    transport: { kind: 'stdio', command: '/definitely/not/a/binary', args: [] },
  });
  const client = new StdioZoneClient(zone);
  t.after(() => client.close());

  await assert.rejects(
    () => client.search('q', 5, 3000),
    (error: unknown) => error instanceof KnsError && error.code === 'zone_unavailable',
  );
});

test('an oversized message is rejected without hanging the caller', async (t) => {
  const client = new StdioZoneClient(fakeZone('oversize'));
  t.after(() => client.close());

  await assert.rejects(
    () => client.search('q', 5, 3000),
    (error: unknown) => error instanceof KnsError && error.code === 'zone_unavailable',
  );
});

test('close is idempotent and fails subsequent calls', async () => {
  const client = new StdioZoneClient(fakeZone('ok'));
  await client.search('q', 5, 4000);

  await client.close();
  await client.close();

  await assert.rejects(
    () => client.search('q', 5, 1000),
    (error: unknown) => error instanceof KnsError && error.code === 'zone_unavailable',
  );
});

test('closing a client that never connected is a no-op', async () => {
  const client = new StdioZoneClient(fakeZone('ok'));
  await client.close();
});
