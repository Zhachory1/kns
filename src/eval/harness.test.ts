import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultConfig } from '../core/config.ts';
import { EVAL_DOCUMENTS, EVAL_QUERIES, EVAL_ZONES, PRIVATE_DOCUMENT_IDS } from './fixtures.ts';
import {
  fixtureClientFactory,
  fixtureRegistry,
  formatReport,
  overlapScore,
  runEval,
  runUserOnlyBaseline,
} from './harness.ts';

test('every fixture query names a document that exists in its expected zone', () => {
  for (const query of EVAL_QUERIES) {
    const match = EVAL_DOCUMENTS.find(
      (document) => document.id === query.expectedDocumentId && document.zone === query.expectedZone,
    );
    assert.ok(match, `${query.name}: ${query.expectedDocumentId} is not in ${query.expectedZone}`);
  }
});

test('the fixture corpus covers the adversarial cases the design calls out', () => {
  const names = EVAL_QUERIES.map((query) => query.name).join(' | ');

  assert.match(names, /stale company versus fresh team/);
  assert.match(names, /weak local versus strong company/);
  assert.match(names, /promoted into two zones/);
  assert.ok(PRIVATE_DOCUMENT_IDS.length > 0, 'a leak case needs private content to leak');
  assert.equal(EVAL_ZONES.length, 3);
});

test('overlapScore counts shared terms and ignores case', () => {
  const document = EVAL_DOCUMENTS[0];
  assert.ok(document);
  assert.ok(overlapScore(document, 'LAPTOP setup') > 0);
  assert.equal(overlapScore(document, 'unrelated terminology'), 0);
});

test('the fixture registry mirrors the fixture zones', () => {
  const registry = fixtureRegistry();

  assert.deepEqual(
    registry.zones.map((zone) => zone.name),
    EVAL_ZONES.map((zone) => zone.name),
  );
  assert.deepEqual(
    registry.zones.map((zone) => zone.distance),
    [0, 1, 2],
  );
});

test('the fixture engine only serves documents from its own zone', async () => {
  const factory = fixtureClientFactory();
  const registry = fixtureRegistry();
  const teamZone = registry.zones.find((zone) => zone.name === 'team');
  assert.ok(teamZone);

  const hits = await factory(teamZone).search('index reload oncall', 10, 1000);
  assert.ok(hits.length > 0);
  for (const hit of hits) {
    const document = EVAL_DOCUMENTS.find((entry) => entry.id === hit.documentId && entry.zone === 'team');
    assert.ok(document, `${hit.documentId} did not come from the team zone`);
  }
});

test('the harness gets every adversarial case right with the shipped defaults', async () => {
  const report = await runEval();

  assert.equal(report.metrics.queries, EVAL_QUERIES.length);
  assert.equal(report.metrics.authorityAtOne, 1, JSON.stringify(report.cases, null, 2));
  assert.equal(report.metrics.recallAtK, 1);
});

test('no private document ever surfaces from a shared zone', async () => {
  const report = await runEval();
  assert.equal(report.metrics.leakCount, 0, 'leakCount is a release gate');
});

test('the hierarchy does not regress against the USER-only baseline', async () => {
  const config = defaultConfig();
  const report = await runEval(config);
  const baseline = await runUserOnlyBaseline(config);

  assert.ok(report.metrics.recallAtK >= baseline.recallAtK);
  assert.ok(report.metrics.authorityAtOne >= baseline.authorityAtOne);
});

test('early exit keeps at least one query off the outer zones', async () => {
  const report = await runEval();

  assert.ok(report.metrics.fanoutRate < 1, 'a clear local answer should stop the walk');
  assert.ok(report.cases.some((entry) => entry.earlyExitAt === 0));
});

test('disabling early exit raises the fanout rate', async () => {
  const config = defaultConfig();
  config.earlyExit.marginMin = 1.1;

  const report = await runEval(config);
  assert.equal(report.metrics.fanoutRate, 1, 'an unreachable margin must never stop the walk');
});

test('the report renders as a committable readout', async () => {
  const config = defaultConfig();
  const report = await runEval(config);
  const markdown = formatReport(report, await runUserOnlyBaseline(config));

  assert.match(markdown, /\| `authority@1` \| 100% \|/);
  assert.match(markdown, /\| `leakCount` \| 0 \|/);
  assert.match(markdown, /stale company versus fresh team/);
});
