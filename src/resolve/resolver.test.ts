import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultConfig } from '../core/config.ts';
import { KnsError } from '../core/errors.ts';
import type { Registry } from '../core/registry.ts';
import { SCHEMA_VERSION } from '../version.ts';
import type { ResolveRequest, Zone } from '../core/types.ts';
import type { RawHit, ZoneClient, ZoneStatus } from '../zone/client.ts';
import { queryZone, resolve, withConcurrency } from './resolver.ts';
import type { ResolveDeps } from './resolver.ts';

const NOW = new Date('2026-08-10T12:00:00.000Z');

/** A zone with overridable fields. */
function zone(overrides: Partial<Zone> = {}): Zone {
  return {
    name: 'user',
    namespace: 'user',
    tier: 'USER',
    distance: 0,
    transport: { kind: 'stdio', command: 'zbrain-mcp', args: [] },
    ttlSeconds: 0,
    halfLifeDays: 365,
    owner: null,
    sourceRepo: null,
    neverEarlyExit: false,
    ...overrides,
  };
}

/** Behaviour of a stub zone client. */
interface StubBehaviour {
  hits?: RawHit[];
  fail?: Error;
  delayMs?: number;
}

/** Records what the stubs did, so tests can assert on lifecycle. */
interface StubLog {
  searched: string[];
  closed: string[];
  concurrent: number;
  peakConcurrent: number;
}

/** Build a client factory backed by per-zone stub behaviour. */
function stubFactory(
  behaviour: Record<string, StubBehaviour>,
  log: StubLog,
): (zone: Zone) => ZoneClient {
  return (target: Zone): ZoneClient => ({
    zone: target,
    async search(): Promise<RawHit[]> {
      log.searched.push(target.name);
      log.concurrent += 1;
      log.peakConcurrent = Math.max(log.peakConcurrent, log.concurrent);
      try {
        const spec = behaviour[target.name] ?? {};
        if (spec.delayMs !== undefined) {
          await new Promise((done) => setTimeout(done, spec.delayMs));
        }
        if (spec.fail !== undefined) throw spec.fail;
        return spec.hits ?? [];
      } finally {
        log.concurrent -= 1;
      }
    },
    async get(): Promise<string> {
      return '';
    },
    async status(): Promise<ZoneStatus> {
      return { documents: null, generation: null };
    },
    async close(): Promise<void> {
      log.closed.push(target.name);
    },
  });
}

/** A raw hit with overridable fields. */
function raw(documentId: string, overrides: Partial<RawHit> = {}): RawHit {
  return {
    documentId,
    snippet: `snippet for ${documentId}`,
    score: 1,
    owner: null,
    modified: null,
    sourceVersion: null,
    ...overrides,
  };
}

/** A request with overridable fields. */
function request(overrides: Partial<ResolveRequest> = {}): ResolveRequest {
  return { query: 'index reload', k: 10, mode: 'exact', scope: null, noEarlyExit: false, ...overrides };
}

/** Assemble dependencies around a set of zones and stub behaviour. */
function deps(
  zones: Zone[],
  behaviour: Record<string, StubBehaviour> = {},
): { deps: ResolveDeps; log: StubLog } {
  const log: StubLog = { searched: [], closed: [], concurrent: 0, peakConcurrent: 0 };
  const registry: Registry = { schemaVersion: SCHEMA_VERSION, zones };

  return {
    deps: { registry, config: defaultConfig(), createClient: stubFactory(behaviour, log), now: NOW },
    log,
  };
}

test('withConcurrency preserves order and respects the limit', async () => {
  let active = 0;
  let peak = 0;

  const tasks = Array.from({ length: 8 }, (_unused, index) => async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((done) => setTimeout(done, 5));
    active -= 1;
    return index;
  });

  assert.deepEqual(await withConcurrency(tasks, 3), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(peak <= 3, `expected at most 3 concurrent, saw ${peak}`);
});

test('withConcurrency handles an empty task list', async () => {
  assert.deepEqual(await withConcurrency([], 4), []);
});

test('queryZone annotates hits and always closes the client', async () => {
  const target = zone();
  const context = deps([target], { user: { hits: [raw('a.md'), raw('b.md')] } });

  const outcome = await queryZone(target, request(), context.deps);

  assert.equal(outcome.warning, null);
  assert.deepEqual(
    outcome.hits.map((hit) => hit.documentId),
    ['a.md', 'b.md'],
  );
  assert.equal(outcome.hits[0]?.provenance.zone, 'user');
  assert.deepEqual(context.log.closed, ['user']);
});

test('queryZone converts a zone failure into a warning and still closes', async () => {
  const target = zone();
  const context = deps([target], {
    user: { fail: new KnsError('zone_timeout', 'too slow') },
  });

  const outcome = await queryZone(target, request(), context.deps);

  assert.deepEqual(outcome.hits, []);
  assert.equal(outcome.warning?.code, 'zone_timeout');
  assert.equal(outcome.warning?.zone, 'user');
  assert.deepEqual(context.log.closed, ['user'], 'a failing zone must not leak its client');
});

test('queryZone labels a non-KnsError failure as internal', async () => {
  const target = zone();
  const context = deps([target], { user: { fail: new TypeError('bad') } });

  const outcome = await queryZone(target, request(), context.deps);
  assert.equal(outcome.warning?.code, 'internal');
});

test('resolve returns annotated hits from the nearest zone', async () => {
  const context = deps([zone()], {
    user: { hits: [raw('a.md', { modified: '2026-08-05T12:00:00.000Z' })] },
  });

  const result = await resolve(request(), context.deps);

  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0]?.provenance.tier, 'USER');
  assert.equal(result.hits[0]?.provenance.ageDays, 5);
  assert.deepEqual(result.zonesQueried, ['user']);
  assert.equal(result.partial, false);
  assert.deepEqual(result.warnings, []);
  assert.ok(result.resolveMs >= 0);
});

test('resolve queries every zone in the nearest band', async () => {
  const zones = [
    zone({ name: 'user-a' }),
    zone({ name: 'user-b' }),
    zone({ name: 'team', namespace: 'company/platform', tier: 'TEAM', distance: 1 }),
  ];
  const context = deps(zones, {
    'user-a': { hits: [raw('a.md')] },
    'user-b': { hits: [raw('b.md')] },
    team: { hits: [raw('t.md')] },
  });

  const result = await resolve(request(), context.deps);

  assert.deepEqual(result.zonesQueried, ['user-a', 'user-b']);
  assert.deepEqual(
    result.hits.map((hit) => hit.documentId),
    ['a.md', 'b.md'],
  );
  assert.equal(result.earlyExitAt, 0, 'the walk stopped at the nearest band');
});

test('resolve marks a partial result when a zone fails but others answer', async () => {
  const context = deps([zone({ name: 'user-a' }), zone({ name: 'user-b' })], {
    'user-a': { hits: [raw('a.md')] },
    'user-b': { fail: new KnsError('zone_unavailable', 'not running') },
  });

  const result = await resolve(request(), context.deps);

  assert.equal(result.hits.length, 1);
  assert.equal(result.partial, true);
  assert.equal(result.warnings[0]?.zone, 'user-b');
});

test('resolve returns an empty result rather than throwing when every zone fails', async () => {
  const context = deps([zone()], { user: { fail: new KnsError('zone_timeout', 'slow') } });

  const result = await resolve(request(), context.deps);

  assert.deepEqual(result.hits, []);
  assert.equal(result.partial, true);
});

test('resolve warns when no zones are configured', async () => {
  const context = deps([]);
  const result = await resolve(request(), context.deps);

  assert.deepEqual(result.hits, []);
  assert.equal(result.partial, false, 'an empty registry is a configuration gap, not a zone failure');
  assert.match(result.warnings[0]?.message ?? '', /no zones configured/);
});

test('resolve warns when a scope matches nothing', async () => {
  const context = deps([zone()]);
  const result = await resolve(request({ scope: 'company/platform' }), context.deps);

  assert.deepEqual(result.zonesQueried, []);
  assert.match(result.warnings[0]?.message ?? '', /no zones match scope "company\/platform"/);
});

test('resolve honours scope when selecting the nearest band', async () => {
  const zones = [
    zone(),
    zone({ name: 'team', namespace: 'company/platform', tier: 'TEAM', distance: 1 }),
  ];
  const context = deps(zones, { team: { hits: [raw('t.md')] } });

  const result = await resolve(request({ scope: 'company/platform' }), context.deps);

  assert.deepEqual(result.zonesQueried, ['team']);
  assert.equal(result.hits[0]?.documentId, 't.md');
  assert.equal(result.earlyExitAt, null, 'the scoped tree had only one band');
});

test('resolve truncates to k', async () => {
  const context = deps([zone()], {
    user: { hits: [raw('a.md'), raw('b.md'), raw('c.md')] },
  });

  const result = await resolve(request({ k: 2 }), context.deps);
  assert.equal(result.hits.length, 2);
});

test('resolve caps how many zones it queries at once', async () => {
  const zones = Array.from({ length: 8 }, (_unused, index) => zone({ name: `user-${index}` }));
  const behaviour = Object.fromEntries(
    zones.map((entry) => [entry.name, { hits: [raw(`${entry.name}.md`)], delayMs: 5 }]),
  );
  const context = deps(zones, behaviour);

  await resolve(request(), context.deps);

  assert.ok(
    context.log.peakConcurrent <= defaultConfig().resolution.maxConcurrentZones,
    `expected at most ${defaultConfig().resolution.maxConcurrentZones} concurrent zones, saw ${context.log.peakConcurrent}`,
  );
});
