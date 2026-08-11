import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { defaultConfig } from '../core/config.ts';
import { KnsError } from '../core/errors.ts';
import type { Registry } from '../core/registry.ts';
import { SCHEMA_VERSION } from '../version.ts';
import type { Zone } from '../core/types.ts';
import type { RawHit, ZoneClient, ZoneStatus } from '../zone/client.ts';
import { MessageFramer, encodeMessage } from '../zone/framing.ts';
import { PROTOCOL_VERSION, TOOLS, callTool, handleMessage, serve } from './server.ts';
import type { ServerDeps } from './server.ts';

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
    ...overrides,
  };
}

/** Server dependencies backed by stub zones. */
function deps(zones: Zone[] = [zone()], hits: RawHit[] = []): ServerDeps {
  const registry: Registry = { schemaVersion: SCHEMA_VERSION, zones };

  return {
    loadRegistry: async () => registry,
    loadConfig: async () => defaultConfig(),
    createClient: (target: Zone): ZoneClient => ({
      zone: target,
      async search(): Promise<RawHit[]> {
        return hits;
      },
      async get(documentId: string, from: number, lines: number): Promise<string> {
        return `excerpt of ${documentId} from ${from} for ${lines}`;
      },
      async status(): Promise<ZoneStatus> {
        return { documents: 1, generation: 'gen-1' };
      },
      async close(): Promise<void> {},
    }),
  };
}

/** A raw hit. */
function raw(documentId: string): RawHit {
  return {
    documentId,
    snippet: `snippet ${documentId}`,
    score: 1,
    owner: 'me',
    modified: '2026-08-09T00:00:00.000Z',
    sourceVersion: 'v1',
  };
}

/** Decode the JSON payload from a tool result. */
function payloadOf(response: unknown): Record<string, unknown> {
  const result = (response as { result: { content: { text: string }[]; isError: boolean } }).result;
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

/** Whether a tool result reported an error. */
function isError(response: unknown): boolean {
  return (response as { result: { isError: boolean } }).result.isError;
}

test('initialize advertises the protocol version and tool capability', async () => {
  const response = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' }, deps());

  assert.deepEqual(response, {
    jsonrpc: '2.0',
    id: 1,
    result: {
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: { name: 'kns', version: '0.0.0' },
      capabilities: { tools: {} },
    },
  });
});

test('notifications receive no response', async () => {
  assert.equal(await handleMessage({ method: 'notifications/initialized' }, deps()), null);
});

test('tools/list advertises exactly the documented tools', async () => {
  const response = await handleMessage({ id: 1, method: 'tools/list' }, deps());
  const tools = (response as { result: { tools: { name: string }[] } }).result.tools;

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['kns.resolve', 'kns.get', 'kns.answer', 'kns.zones', 'kns.status'],
  );
  assert.ok(TOOLS.every((tool) => tool.description.length > 0));
});

test('no tool can promote, and no tool accepts a filesystem root', () => {
  const serialised = JSON.stringify(TOOLS);

  assert.ok(!serialised.includes('promote'), 'promotion needs a human, not a tool call');
  assert.ok(!/"root"|"path"|"command"/.test(serialised), 'roots come from the registry only');
});

test('an unknown method is a JSON-RPC error', async () => {
  const response = await handleMessage({ id: 1, method: 'telepathy' }, deps());
  assert.match((response as { error: { message: string } }).error.message, /unknown method/);
});

test('a message without a method is rejected', async () => {
  const response = await handleMessage({ id: 1 }, deps());
  assert.equal((response as { error: { code: number } }).error.code, -32600);
});

test('kns.resolve returns hits with provenance', async () => {
  const response = await handleMessage(
    { id: 1, method: 'tools/call', params: { name: 'kns.resolve', arguments: { query: 'index reload' } } },
    deps([zone()], [raw('a.md')]),
  );

  assert.equal(isError(response), false);
  const payload = payloadOf(response) as unknown as {
    schemaVersion: number;
    hits: { documentId: string; provenance: { zone: string } }[];
    zonesQueried: string[];
  };

  assert.equal(payload.schemaVersion, SCHEMA_VERSION);
  assert.equal(payload.hits[0]?.documentId, 'a.md');
  assert.equal(payload.hits[0]?.provenance.zone, 'user');
  assert.deepEqual(payload.zonesQueried, ['user']);
});

test('kns.resolve rejects an out-of-range k rather than clamping it', async () => {
  const response = await handleMessage(
    { id: 1, method: 'tools/call', params: { name: 'kns.resolve', arguments: { query: 'q', k: 99 } } },
    deps(),
  );

  assert.equal(isError(response), true);
  assert.match(JSON.stringify(payloadOf(response)), /request\.k/);
});

test('kns.resolve requires a query', async () => {
  const response = await handleMessage(
    { id: 1, method: 'tools/call', params: { name: 'kns.resolve', arguments: {} } },
    deps(),
  );

  assert.equal(isError(response), true);
});

test('kns.answer returns cited evidence', async () => {
  const response = await handleMessage(
    { id: 1, method: 'tools/call', params: { name: 'kns.answer', arguments: { query: 'reload' } } },
    deps([zone()], [raw('a.md')]),
  );

  const payload = payloadOf(response) as unknown as {
    evidence: { documentId: string; zone: string; owner: string; text: string }[];
  };

  assert.equal(payload.evidence[0]?.documentId, 'a.md');
  assert.equal(payload.evidence[0]?.zone, 'user');
  assert.equal(payload.evidence[0]?.owner, 'me');
  assert.match(payload.evidence[0]?.text ?? '', /snippet a\.md/);
});

test('kns.get reads a bounded excerpt from a named zone', async () => {
  const response = await handleMessage(
    {
      id: 1,
      method: 'tools/call',
      params: { name: 'kns.get', arguments: { zone: 'user', id: 'a.md', from: 2, lines: 5 } },
    },
    deps(),
  );

  const payload = payloadOf(response) as unknown as { text: string; from: number; lines: number };
  assert.equal(payload.from, 2);
  assert.equal(payload.lines, 5);
  assert.match(payload.text, /excerpt of a\.md from 2 for 5/);
});

test('kns.get enforces its bounds and requires both arguments', async () => {
  const overLimit = await handleMessage(
    { id: 1, method: 'tools/call', params: { name: 'kns.get', arguments: { zone: 'user', id: 'a.md', lines: 500 } } },
    deps(),
  );
  assert.equal(isError(overLimit), true);

  const missing = await handleMessage(
    { id: 1, method: 'tools/call', params: { name: 'kns.get', arguments: { zone: 'user' } } },
    deps(),
  );
  assert.equal(isError(missing), true);

  const unknownZone = await handleMessage(
    { id: 1, method: 'tools/call', params: { name: 'kns.get', arguments: { zone: 'ghost', id: 'a.md' } } },
    deps(),
  );
  assert.equal(isError(unknownZone), true);
  assert.match(JSON.stringify(payloadOf(unknownZone)), /no zone named .*ghost/);
});

test('kns.zones and kns.status describe the machine', async () => {
  const zones = await handleMessage({ id: 1, method: 'tools/call', params: { name: 'kns.zones' } }, deps());
  const payload = payloadOf(zones) as unknown as { zones: { name: string; tier: string }[] };
  assert.deepEqual(payload.zones, [
    { name: 'user', namespace: 'user', tier: 'USER', distance: 0, owner: null, ttlSeconds: 0 },
  ]);

  const status = await handleMessage({ id: 1, method: 'tools/call', params: { name: 'kns.status' } }, deps());
  assert.deepEqual(payloadOf(status), { schemaVersion: SCHEMA_VERSION, zones: 1, cache: null });
});

test('an unknown tool is an in-band error, not a transport failure', async () => {
  const response = await handleMessage(
    { id: 1, method: 'tools/call', params: { name: 'kns.teleport' } },
    deps(),
  );

  assert.equal(isError(response), true);
  assert.equal((response as { error?: unknown }).error, undefined);
  assert.match(JSON.stringify(payloadOf(response)), /unknown tool/);
});

test('a tool call without a name is rejected', async () => {
  const response = await handleMessage({ id: 1, method: 'tools/call', params: {} }, deps());
  assert.equal(isError(response), true);
});

test('callTool surfaces a KnsError code in the payload', async () => {
  await assert.rejects(
    () => callTool('kns.get', { zone: 'ghost', id: 'a.md' }, deps()),
    (error: unknown) => error instanceof KnsError && error.code === 'invalid_request',
  );
});

test('serve speaks the wire protocol over streams', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const framer = new MessageFramer();
  const received: unknown[] = [];

  output.on('data', (chunk: Buffer) => {
    for (const body of framer.push(chunk)) received.push(JSON.parse(body));
  });

  serve(input, output, deps([zone()], [raw('a.md')]));

  input.write(encodeMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
  input.write(encodeMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  input.write(
    encodeMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'kns.zones' } }),
  );

  await new Promise((done) => setTimeout(done, 120));

  assert.equal(received.length, 2, 'the notification produced no response');
  assert.equal((received[0] as { id: number }).id, 1);
  assert.equal((received[1] as { id: number }).id, 2);
});

test('serve reports a parse error without dying', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const framer = new MessageFramer();
  const received: unknown[] = [];

  output.on('data', (chunk: Buffer) => {
    for (const body of framer.push(chunk)) received.push(JSON.parse(body));
  });

  serve(input, output, deps());
  input.write('{ not json }\n');
  input.write(encodeMessage({ jsonrpc: '2.0', id: 7, method: 'initialize' }));

  await new Promise((done) => setTimeout(done, 120));

  assert.equal((received[0] as { error: { code: number } }).error.code, -32700);
  assert.equal((received[1] as { id: number }).id, 7, 'the server kept serving');
});

test('serve rejects an oversized frame without dying', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const framer = new MessageFramer();
  const received: unknown[] = [];

  output.on('data', (chunk: Buffer) => {
    for (const body of framer.push(chunk)) received.push(JSON.parse(body));
  });

  serve(input, output, deps());
  input.write(`Content-Length: ${1024 * 1024 * 8}\r\n\r\n`);

  await new Promise((done) => setTimeout(done, 80));
  assert.match(JSON.stringify(received[0]), /message too large/);
});
