import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SCHEMA_VERSION } from '../version.ts';
import { KnsError } from './errors.ts';
import type { Zone } from './types.ts';
import {
  REGISTRY_FILE,
  addZone,
  emptyRegistry,
  findZone,
  groupByDistance,
  knsHome,
  loadRegistry,
  namespaceMatches,
  parseRegistry,
  removeZone,
  saveRegistry,
  selectZones,
} from './registry.ts';
import type { Registry } from './registry.ts';

/** Build a zone with sensible defaults. */
function zone(overrides: Partial<Zone> = {}): Zone {
  return {
    name: 'user',
    namespace: 'user',
    tier: 'USER',
    distance: 0,
    transport: { kind: 'stdio', command: 'zbrain-mcp', args: ['--root', '/docs'] },
    ttlSeconds: 0,
    halfLifeDays: 365,
    owner: null,
    sourceRepo: null,
    neverEarlyExit: false,
    ...overrides,
  };
}

/** Registry document as it appears on disk. */
function document(zones: Record<string, unknown>[]): Record<string, unknown> {
  return { schemaVersion: SCHEMA_VERSION, zones };
}

/** Serialisable form of a valid zone. */
function zoneDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'user',
    namespace: 'user',
    tier: 'USER',
    distance: 0,
    transport: { kind: 'stdio', command: 'zbrain-mcp', args: ['--root', '/docs'] },
    ...overrides,
  };
}

/** A registry containing the given zones. */
function registryOf(zones: Zone[]): Registry {
  return { schemaVersion: SCHEMA_VERSION, zones };
}

test('knsHome honours KNS_HOME and falls back to the home directory', () => {
  assert.equal(knsHome({ KNS_HOME: '/tmp/kns-home' }), path.resolve('/tmp/kns-home'));
  assert.equal(knsHome({ KNS_HOME: '   ' }), path.join(process.env['HOME'] ?? '', '.kns'));
  assert.equal(knsHome({}), path.join(process.env['HOME'] ?? '', '.kns'));
});

test('parseRegistry accepts a well-formed document', () => {
  const result = parseRegistry(document([zoneDocument()]));

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.zones.length, 1);
  assert.equal(result.ok && result.value.zones[0]?.name, 'user');
});

test('parseRegistry rejects non-objects, unknown fields, and bad versions', () => {
  assert.equal(parseRegistry(null).ok, false);
  assert.equal(parseRegistry([]).ok, false);
  assert.equal(parseRegistry({ ...document([]), extra: 1 }).ok, false);
  assert.equal(parseRegistry({ zones: [] }).ok, false);
  assert.equal(parseRegistry({ schemaVersion: 1.5, zones: [] }).ok, false);
  assert.equal(parseRegistry({ schemaVersion: SCHEMA_VERSION + 1, zones: [] }).ok, false);
  assert.equal(parseRegistry({ schemaVersion: SCHEMA_VERSION }).ok, false);
});

test('parseRegistry reports the index of an invalid zone', () => {
  const result = parseRegistry(document([zoneDocument(), zoneDocument({ tier: 'NOPE' })]));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.issues[0]?.path, 'registry.zones[1].tier');
});

test('parseRegistry rejects duplicate zone names', () => {
  const result = parseRegistry(document([zoneDocument(), zoneDocument()]));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.issues[0]?.message ?? '', /duplicate zone name "user"/);
});

test('loadRegistry treats a missing file as an empty registry', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'kns-registry-'));
  assert.deepEqual(await loadRegistry(home), emptyRegistry());
});

test('loadRegistry fails closed on invalid JSON', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'kns-registry-'));
  await writeFile(path.join(home, REGISTRY_FILE), '{ not json', 'utf8');

  await assert.rejects(
    () => loadRegistry(home),
    (error: unknown) =>
      error instanceof KnsError &&
      error.code === 'registry_invalid' &&
      /not valid JSON/.test(error.message),
  );
});

test('loadRegistry fails closed on a schema violation, loading no zones', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'kns-registry-'));
  await writeFile(
    path.join(home, REGISTRY_FILE),
    JSON.stringify(document([zoneDocument(), zoneDocument({ name: 'broken', tier: 'NOPE' })])),
    'utf8',
  );

  await assert.rejects(
    () => loadRegistry(home),
    (error: unknown) => error instanceof KnsError && error.code === 'registry_invalid',
  );
});

test('saveRegistry round-trips through loadRegistry and creates the home directory', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'kns-registry-'));
  const home = path.join(base, 'nested', 'home');

  const registry = registryOf([zone(), zone({ name: 'team', namespace: 'company/team', tier: 'TEAM', distance: 1 })]);
  await saveRegistry(home, registry);

  assert.deepEqual(await loadRegistry(home), registry);
});

test('addZone rejects a duplicate name and returns a new registry', () => {
  const registry = registryOf([zone()]);
  const extended = addZone(registry, zone({ name: 'team', distance: 1 }));

  assert.equal(extended.zones.length, 2);
  assert.equal(registry.zones.length, 1, 'input registry must not be mutated');
  assert.throws(
    () => addZone(extended, zone()),
    (error: unknown) => error instanceof KnsError && error.code === 'invalid_request',
  );
});

test('removeZone rejects an unknown name and returns a new registry', () => {
  const registry = registryOf([zone(), zone({ name: 'team', distance: 1 })]);
  const reduced = removeZone(registry, 'team');

  assert.deepEqual(
    reduced.zones.map((entry) => entry.name),
    ['user'],
  );
  assert.equal(registry.zones.length, 2, 'input registry must not be mutated');
  assert.throws(
    () => removeZone(reduced, 'team'),
    (error: unknown) => error instanceof KnsError && error.code === 'invalid_request',
  );
});

test('findZone returns null for an unknown name', () => {
  const registry = registryOf([zone()]);
  assert.equal(findZone(registry, 'user')?.name, 'user');
  assert.equal(findZone(registry, 'absent'), null);
});

test('namespaceMatches compares whole segments', () => {
  assert.equal(namespaceMatches('company/platform', null), true);
  assert.equal(namespaceMatches('company/platform', ''), true);
  assert.equal(namespaceMatches('company/platform', 'company'), true);
  assert.equal(namespaceMatches('company/platform', 'company/platform'), true);
  assert.equal(namespaceMatches('company/platform/search', 'company/platform'), true);

  assert.equal(namespaceMatches('company/platform', 'company/plat'), false);
  assert.equal(namespaceMatches('company', 'company/platform'), false);
  assert.equal(namespaceMatches('other/platform', 'company'), false);
});

test('selectZones filters by scope and sorts by distance then name', () => {
  const registry = registryOf([
    zone({ name: 'company', namespace: 'company', tier: 'COMPANY', distance: 2 }),
    zone({ name: 'team-b', namespace: 'company/platform', tier: 'TEAM', distance: 1 }),
    zone({ name: 'team-a', namespace: 'company/platform', tier: 'TEAM', distance: 1 }),
    zone(),
  ]);

  assert.deepEqual(
    selectZones(registry).map((entry) => entry.name),
    ['user', 'team-a', 'team-b', 'company'],
  );
  assert.deepEqual(
    selectZones(registry, 'company/platform').map((entry) => entry.name),
    ['team-a', 'team-b'],
  );
  assert.deepEqual(selectZones(registry, 'company/plat'), []);
});

test('groupByDistance bands zones for the resolution walk', () => {
  const zones = selectZones(
    registryOf([
      zone(),
      zone({ name: 'team-a', namespace: 'company/platform', tier: 'TEAM', distance: 1 }),
      zone({ name: 'team-b', namespace: 'company/platform', tier: 'TEAM', distance: 1 }),
      zone({ name: 'company', namespace: 'company', tier: 'COMPANY', distance: 2 }),
    ]),
  );

  assert.deepEqual(
    groupByDistance(zones).map((group) => group.map((entry) => entry.name)),
    [['user'], ['team-a', 'team-b'], ['company']],
  );
  assert.deepEqual(groupByDistance([]), []);
});

test('loadRegistry reads a registry written outside the API', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'kns-registry-'));
  await mkdir(home, { recursive: true });
  await writeFile(
    path.join(home, REGISTRY_FILE),
    JSON.stringify(document([zoneDocument({ ttlSeconds: 3600, owner: 'me' })])),
    'utf8',
  );

  const registry = await loadRegistry(home);
  assert.equal(registry.zones[0]?.ttlSeconds, 3600);
  assert.equal(registry.zones[0]?.owner, 'me');
});
