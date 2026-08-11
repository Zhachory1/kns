import test from 'node:test';
import assert from 'node:assert/strict';

import { TIERS, TRANSPORT_KINDS, isTier } from './types.ts';
import type { ValidationIssue, ValidationResult } from './validate.ts';
import {
  DEFAULT_HALF_LIFE_DAYS,
  K_MAX,
  QUERY_MAX,
  issuesToError,
  parseResolveRequest,
  parseTransport,
  parseZone,
} from './validate.ts';

/** A registry entry with every field present and valid. */
function validZone(): Record<string, unknown> {
  return {
    name: 'team-platform',
    namespace: 'company/platform',
    tier: 'TEAM',
    distance: 1,
    transport: { kind: 'stdio', command: 'zbrain-mcp', args: ['--root', '/zones/platform'] },
    ttlSeconds: 3600,
    halfLifeDays: 180,
    owner: 'platform-team',
    sourceRepo: 'git@example.com:org/platform-docs.git',
    neverEarlyExit: false,
    delegatesTo: [],
  };
}

/** Assert failure and return the issue paths. */
function issuePaths<T>(result: ValidationResult<T>): string[] {
  assert.equal(result.ok, false, 'expected validation to fail');
  return (result as { ok: false; issues: ValidationIssue[] }).issues.map((issue) => issue.path);
}

test('isTier recognises exactly the known tiers', () => {
  for (const tier of TIERS) assert.ok(isTier(tier));
  assert.equal(isTier('OTHER'), false);
  assert.equal(isTier(null), false);
});

test('parseTransport accepts a well-formed transport', () => {
  const result = parseTransport({ kind: 'stdio', command: 'zbrain-mcp', args: ['--root', '/x'] });

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.value, {
    kind: 'stdio',
    command: 'zbrain-mcp',
    args: ['--root', '/x'],
  });
});

test('parseTransport defaults args and rejects unknown transport kinds', () => {
  const withoutArgs = parseTransport({ kind: 'stdio', command: 'zbrain-mcp' });
  assert.deepEqual(withoutArgs.ok && withoutArgs.value.args, []);

  assert.deepEqual(issuePaths(parseTransport({ kind: 'http', command: 'curl' })), [
    'transport.kind',
  ]);
});

test('parseTransport rejects non-objects', () => {
  assert.deepEqual(issuePaths(parseTransport(null)), ['transport']);
  assert.deepEqual(issuePaths(parseTransport([])), ['transport']);
  assert.deepEqual(issuePaths(parseTransport('stdio')), ['transport']);
});

test('parseTransport rejects a non-string args array', () => {
  assert.deepEqual(issuePaths(parseTransport({ kind: 'stdio', command: 'x', args: [1] })), [
    'transport.args',
  ]);
  assert.deepEqual(issuePaths(parseTransport({ kind: 'stdio', command: 'x', args: 'no' })), [
    'transport.args',
  ]);
});

test('parseZone accepts a complete entry', () => {
  const result = parseZone(validZone());

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.name, 'team-platform');
  assert.equal(result.ok && result.value.transport.command, 'zbrain-mcp');
  assert.equal(result.ok && result.value.neverEarlyExit, false);
});

test('parseZone applies documented defaults', () => {
  const zone = validZone();
  delete zone['ttlSeconds'];
  delete zone['halfLifeDays'];
  delete zone['neverEarlyExit'];
  delete zone['owner'];
  delete zone['sourceRepo'];

  const result = parseZone(zone);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.ttlSeconds, 0);
  assert.equal(result.value.halfLifeDays, DEFAULT_HALF_LIFE_DAYS);
  assert.equal(result.value.neverEarlyExit, false);
  assert.equal(result.value.owner, null);
  assert.equal(result.value.sourceRepo, null);
});

test('parseZone rejects unknown fields rather than ignoring them', () => {
  const zone = { ...validZone(), tyer: 'TEAM' };
  assert.deepEqual(issuePaths(parseZone(zone)), ['zone.tyer']);
});

test('parseZone requires distance and rejects a non-integer', () => {
  const missing = validZone();
  delete missing['distance'];
  assert.deepEqual(issuePaths(parseZone(missing)), ['zone.distance']);

  assert.deepEqual(issuePaths(parseZone({ ...validZone(), distance: 1.5 })), ['zone.distance']);
  assert.deepEqual(issuePaths(parseZone({ ...validZone(), distance: -1 })), ['zone.distance']);
  assert.deepEqual(issuePaths(parseZone({ ...validZone(), distance: Number.NaN })), [
    'zone.distance',
  ]);
  assert.deepEqual(issuePaths(parseZone({ ...validZone(), distance: '1' })), ['zone.distance']);
});

test('parseZone rejects empty and mistyped strings', () => {
  assert.deepEqual(issuePaths(parseZone({ ...validZone(), name: '  ' })), ['zone.name']);
  assert.deepEqual(issuePaths(parseZone({ ...validZone(), namespace: 42 })), ['zone.namespace']);
  assert.deepEqual(issuePaths(parseZone({ ...validZone(), owner: '' })), ['zone.owner']);
});

test('parseZone rejects an unknown tier and a mistyped flag', () => {
  assert.deepEqual(issuePaths(parseZone({ ...validZone(), tier: 'DEPARTMENT' })), ['zone.tier']);
  assert.deepEqual(issuePaths(parseZone({ ...validZone(), neverEarlyExit: 'yes' })), [
    'zone.neverEarlyExit',
  ]);
});

test('parseZone rejects out-of-range lifetimes', () => {
  assert.deepEqual(issuePaths(parseZone({ ...validZone(), ttlSeconds: -1 })), ['zone.ttlSeconds']);
  assert.deepEqual(issuePaths(parseZone({ ...validZone(), halfLifeDays: 0 })), [
    'zone.halfLifeDays',
  ]);
});

test('parseZone reports transport issues under the transport path', () => {
  const zone = { ...validZone(), transport: { kind: 'stdio' } };
  assert.deepEqual(issuePaths(parseZone(zone)), ['zone.transport.command']);
});

test('parseZone rejects a missing transport', () => {
  const zone = validZone();
  delete zone['transport'];
  assert.deepEqual(issuePaths(parseZone(zone)), ['zone.transport']);
});

test('parseZone rejects non-objects', () => {
  assert.deepEqual(issuePaths(parseZone(null)), ['zone']);
});

test('parseZone accepts every known transport kind', () => {
  for (const kind of TRANSPORT_KINDS) {
    const zone = { ...validZone(), transport: { kind, command: 'x', args: [] } };
    assert.equal(parseZone(zone).ok, true);
  }
});

test('parseResolveRequest applies defaults to a bare query', () => {
  const result = parseResolveRequest({ query: 'index reloads' });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value, {
    query: 'index reloads',
    k: 10,
    mode: 'exact',
    scope: null,
    noEarlyExit: false,
  });
});

test('parseResolveRequest honours explicit options', () => {
  const result = parseResolveRequest({
    query: 'x',
    k: K_MAX,
    mode: 'broad',
    scope: 'company/platform',
    noEarlyExit: true,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.k, K_MAX);
  assert.equal(result.value.mode, 'broad');
  assert.equal(result.value.scope, 'company/platform');
  assert.equal(result.value.noEarlyExit, true);
});

test('parseResolveRequest rejects rather than clamps out-of-range k', () => {
  assert.deepEqual(issuePaths(parseResolveRequest({ query: 'x', k: 0 })), ['request.k']);
  assert.deepEqual(issuePaths(parseResolveRequest({ query: 'x', k: K_MAX + 1 })), ['request.k']);
});

test('parseResolveRequest rejects an over-long query and a bad mode', () => {
  const long = 'a'.repeat(QUERY_MAX + 1);
  assert.deepEqual(issuePaths(parseResolveRequest({ query: long })), ['request.query']);
  assert.deepEqual(issuePaths(parseResolveRequest({ query: 'x', mode: 'fuzzy' })), ['request.mode']);
});

test('parseResolveRequest requires a query and rejects unknown fields', () => {
  assert.deepEqual(issuePaths(parseResolveRequest({})), ['request.query']);
  assert.deepEqual(issuePaths(parseResolveRequest({ query: 'x', limit: 5 })), ['request.limit']);
  assert.deepEqual(issuePaths(parseResolveRequest(null)), ['request']);
});

test('issuesToError names every offending path', () => {
  const error = issuesToError(
    [
      { path: 'zone.name', message: 'expected a non-empty string' },
      { path: 'zone.distance', message: 'is required' },
    ],
    'registry_invalid',
  );

  assert.equal(error.code, 'registry_invalid');
  assert.match(error.message, /zone\.name: expected a non-empty string/);
  assert.match(error.message, /zone\.distance: is required/);
  assert.equal(error.nextStep, 'correct the reported fields');
});

test('issuesToError defaults to invalid_request', () => {
  assert.equal(issuesToError([{ path: 'request.k', message: 'bad' }]).code, 'invalid_request');
});
