import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SCHEMA_VERSION } from '../version.ts';
import { CONFIG_FILE, defaultConfig, loadConfig, parseConfig } from './config.ts';
import { KnsError } from './errors.ts';

/** Assert failure and return the issue paths. */
function issuePaths(result: ReturnType<typeof parseConfig>): string[] {
  assert.equal(result.ok, false);
  return result.ok ? [] : result.issues.map((issue) => issue.path);
}

test('defaultConfig returns a fresh, mutable copy', () => {
  const first = defaultConfig();
  first.resolution.k = 3;
  assert.equal(defaultConfig().resolution.k, 10);
});

test('defaults are conservative and documented', () => {
  const config = defaultConfig();

  assert.equal(config.resolution.k, 10);
  assert.equal(config.resolution.zoneDeadlineMs, 1500);
  assert.equal(config.resolution.resolveDeadlineMs, 4000);
  assert.equal(config.resolution.maxConcurrentZones, 4);
  assert.equal(config.ranking.rrfK, 10);
  assert.equal(config.ranking.nearnessBase, 0.9);
  assert.equal(config.earlyExit.marginMin, 0.15);
  assert.equal(config.earlyExit.authoritativeMaxAgeDays, 90);
});

test('parseConfig fills in defaults for absent sections and keys', () => {
  const result = parseConfig({ resolution: { k: 5 } });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.resolution.k, 5);
  assert.equal(result.value.resolution.zoneDeadlineMs, 1500);
  assert.equal(result.value.ranking.rrfK, 10);
});

test('parseConfig accepts null and undefined as "use defaults"', () => {
  assert.deepEqual(parseConfig(undefined), { ok: true, value: defaultConfig() });
  assert.deepEqual(parseConfig(null), { ok: true, value: defaultConfig() });
});

test('parseConfig rejects unknown sections and keys', () => {
  assert.deepEqual(issuePaths(parseConfig({ resolutionn: {} })), ['config.resolutionn']);
  assert.deepEqual(issuePaths(parseConfig({ ranking: { rrfK2: 1 } })), ['config.ranking.rrfK2']);
});

test('parseConfig enforces types, integrality, and ranges', () => {
  assert.deepEqual(issuePaths(parseConfig({ resolution: { k: 'five' } })), ['config.resolution.k']);
  assert.deepEqual(issuePaths(parseConfig({ resolution: { k: 2.5 } })), ['config.resolution.k']);
  assert.deepEqual(issuePaths(parseConfig({ resolution: { k: 0 } })), ['config.resolution.k']);
  assert.deepEqual(issuePaths(parseConfig({ resolution: { k: 21 } })), ['config.resolution.k']);
  assert.deepEqual(issuePaths(parseConfig({ ranking: { nearnessBase: 2 } })), [
    'config.ranking.nearnessBase',
  ]);
  assert.deepEqual(issuePaths(parseConfig({ earlyExit: { minHits: 0 } })), [
    'config.earlyExit.minHits',
  ]);
  assert.deepEqual(issuePaths(parseConfig({ resolution: { k: Number.POSITIVE_INFINITY } })), [
    'config.resolution.k',
  ]);
});

test('parseConfig rejects a non-object document or section', () => {
  assert.deepEqual(issuePaths(parseConfig([])), ['config']);
  assert.deepEqual(issuePaths(parseConfig({ ranking: [] })), ['config.ranking']);
  assert.deepEqual(issuePaths(parseConfig({ ranking: 3 })), ['config.ranking']);
});

test('parseConfig rejects an unsupported schema version', () => {
  assert.equal(parseConfig({ schemaVersion: SCHEMA_VERSION }).ok, true);
  assert.deepEqual(issuePaths(parseConfig({ schemaVersion: 99 })), ['config.schemaVersion']);
});

test('parseConfig accepts a fractional ranking weight', () => {
  const result = parseConfig({ ranking: { nearnessBase: 0.75, staleFactor: 0.25 } });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.ranking.nearnessBase, 0.75);
  assert.equal(result.value.ranking.staleFactor, 0.25);
});

test('loadConfig returns defaults when no file exists', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'kns-config-'));
  assert.deepEqual(await loadConfig(home), defaultConfig());
});

test('loadConfig merges a partial file over the defaults', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'kns-config-'));
  await writeFile(path.join(home, CONFIG_FILE), JSON.stringify({ resolution: { k: 3 } }), 'utf8');

  const config = await loadConfig(home);
  assert.equal(config.resolution.k, 3);
  assert.equal(config.ranking.rrfK, 10);
});

test('loadConfig fails loudly rather than silently using defaults', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'kns-config-'));
  await writeFile(path.join(home, CONFIG_FILE), '{ nope', 'utf8');

  await assert.rejects(
    () => loadConfig(home),
    (error: unknown) => error instanceof KnsError && /not valid JSON/.test(error.message),
  );

  await writeFile(path.join(home, CONFIG_FILE), JSON.stringify({ resolution: { k: 99 } }), 'utf8');
  await assert.rejects(
    () => loadConfig(home),
    (error: unknown) => error instanceof KnsError && error.code === 'invalid_request',
  );
});
