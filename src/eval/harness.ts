/**
 * Evaluation harness.
 *
 * Ranking weights and early-exit thresholds are not tunable by intuition, so this
 * measures them. Each zone is served by a deterministic in-process engine, which keeps
 * the numbers about the router rather than about whichever backend happens to be
 * installed.
 *
 * @module
 */

import type { KnsConfig } from '../core/config.ts';
import { defaultConfig } from '../core/config.ts';
import type { Registry } from '../core/registry.ts';
import type { ResolveRequest, Zone } from '../core/types.ts';
import { SCHEMA_VERSION } from '../version.ts';
import type { RawHit, ZoneClient, ZoneStatus } from '../zone/client.ts';
import { resolve } from '../resolve/resolver.ts';
import {
  EVAL_DOCUMENTS,
  EVAL_NOW,
  EVAL_QUERIES,
  EVAL_ZONES,
  PRIVATE_DOCUMENT_IDS,
} from './fixtures.ts';
import type { EvalDocument, EvalQuery } from './fixtures.ts';

/** Metrics for one harness run. */
export interface EvalMetrics {
  /** Queries evaluated. */
  queries: number;
  /** Share of queries whose expected document appeared in the top k. */
  recallAtK: number;
  /** Share of queries whose top hit came from the expected document and zone. */
  authorityAtOne: number;
  /** Share of queries that left distance zero. */
  fanoutRate: number;
  /** 95th percentile resolution time in milliseconds. */
  p95ResolveMs: number;
  /** Private documents that surfaced from a shared zone. Must be zero. */
  leakCount: number;
}

/** Per-query detail, so a regression can be attributed. */
export interface EvalCase {
  /** Case name. */
  name: string;
  /** Whether the expected document ranked first, from the expected zone. */
  authoritative: boolean;
  /** Whether the expected document appeared at all. */
  recalled: boolean;
  /** Zone of the top hit, or null when there were none. */
  topZone: string | null;
  /** Document id of the top hit, or null. */
  topDocumentId: string | null;
  /** Distance at which the walk stopped, or null. */
  earlyExitAt: number | null;
}

/** A complete harness result. */
export interface EvalReport {
  /** Wire schema version. */
  schemaVersion: number;
  /** Metrics across the query set. */
  metrics: EvalMetrics;
  /** Per-query outcomes. */
  cases: EvalCase[];
}

/** Split text into lowercase word tokens. */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * Score a document against a query by term overlap.
 *
 * Deliberately simple and deterministic. The harness measures routing and fusion, so
 * the per-zone engine only has to produce a defensible, reproducible order.
 *
 * @param document - Corpus document.
 * @param query - Query text.
 * @returns Overlap count, higher being better.
 */
export function overlapScore(document: EvalDocument, query: string): number {
  const terms = new Set(tokenize(query));
  let score = 0;
  for (const token of tokenize(document.text)) {
    if (terms.has(token)) score += 1;
  }
  return score;
}

/**
 * Build a client factory backed by the synthetic corpus.
 *
 * @param documents - Corpus to serve.
 * @param generation - Index generation reported by every zone.
 * @returns A factory suitable for {@link resolve}.
 */
export function fixtureClientFactory(
  documents: readonly EvalDocument[] = EVAL_DOCUMENTS,
  generation = 'gen-1',
): (zone: Zone) => ZoneClient {
  return (zone: Zone): ZoneClient => ({
    zone,
    async search(query: string, limit: number): Promise<RawHit[]> {
      return documents
        .filter((document) => document.zone === zone.name)
        .map((document) => ({ document, score: overlapScore(document, query) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) =>
          right.score === left.score
            ? left.document.id.localeCompare(right.document.id)
            : right.score - left.score,
        )
        .slice(0, limit)
        .map((entry) => ({
          documentId: entry.document.id,
          snippet: entry.document.text,
          score: entry.score,
          owner: entry.document.owner,
          modified: entry.document.modified,
          sourceVersion: generation,
        }));
    },
    async get(): Promise<string> {
      return '';
    },
    async status(): Promise<ZoneStatus> {
      return { documents: documents.length, generation };
    },
    async close(): Promise<void> {},
  });
}

/** Build a registry from the fixture zones. */
export function fixtureRegistry(): Registry {
  return {
    schemaVersion: SCHEMA_VERSION,
    zones: EVAL_ZONES.map((zone) => ({
      name: zone.name,
      namespace: zone.namespace,
      tier: zone.tier,
      distance: zone.distance,
      transport: { kind: 'stdio' as const, command: 'fixture', args: [] },
      ttlSeconds: 0,
      halfLifeDays: zone.halfLifeDays,
      owner: zone.owner,
      sourceRepo: null,
      neverEarlyExit: false,
    delegatesTo: [],
    })),
  };
}

/** The 95th percentile of a sample, using nearest-rank. */
function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

/**
 * Run the harness.
 *
 * @param config - Settings under test. Defaults to the shipped defaults.
 * @param queries - Query set. Defaults to the fixture queries.
 * @returns Metrics and per-query outcomes.
 */
export async function runEval(
  config: KnsConfig = defaultConfig(),
  queries: readonly EvalQuery[] = EVAL_QUERIES,
): Promise<EvalReport> {
  const registry = fixtureRegistry();
  const createClient = fixtureClientFactory();
  const durations: number[] = [];
  const cases: EvalCase[] = [];

  let recalled = 0;
  let authoritative = 0;
  let fannedOut = 0;
  let leakCount = 0;

  for (const query of queries) {
    const request: ResolveRequest = {
      query: query.query,
      k: config.resolution.k,
      mode: 'exact',
      scope: null,
      noEarlyExit: false,
    };

    const started = Date.now();
    const result = await resolve(request, { registry, config, createClient, now: EVAL_NOW });
    durations.push(Date.now() - started);

    const top = result.hits[0] ?? null;
    const didRecall = result.hits.some((hit) => hit.documentId === query.expectedDocumentId);
    const wasAuthoritative =
      top?.documentId === query.expectedDocumentId && top?.provenance.zone === query.expectedZone;

    if (didRecall) recalled += 1;
    if (wasAuthoritative) authoritative += 1;
    if (result.earlyExitAt === null || result.earlyExitAt > 0) fannedOut += 1;

    for (const hit of result.hits) {
      if (PRIVATE_DOCUMENT_IDS.includes(hit.documentId) && hit.provenance.tier !== 'USER') {
        leakCount += 1;
      }
    }

    cases.push({
      name: query.name,
      authoritative: wasAuthoritative,
      recalled: didRecall,
      topZone: top?.provenance.zone ?? null,
      topDocumentId: top?.documentId ?? null,
      earlyExitAt: result.earlyExitAt,
    });
  }

  const total = Math.max(1, queries.length);
  return {
    schemaVersion: SCHEMA_VERSION,
    metrics: {
      queries: queries.length,
      recallAtK: recalled / total,
      authorityAtOne: authoritative / total,
      fanoutRate: fannedOut / total,
      p95ResolveMs: percentile95(durations),
      leakCount,
    },
    cases,
  };
}

/**
 * Measure the USER-only baseline, which every change must not regress against.
 *
 * @param config - Settings under test.
 * @returns Metrics with only the private zone in the registry.
 */
export async function runUserOnlyBaseline(config: KnsConfig = defaultConfig()): Promise<EvalMetrics> {
  const full = fixtureRegistry();
  const registry: Registry = {
    schemaVersion: full.schemaVersion,
    zones: full.zones.filter((zone) => zone.tier === 'USER'),
  };
  const createClient = fixtureClientFactory();

  let recalled = 0;
  let authoritative = 0;
  const durations: number[] = [];

  for (const query of EVAL_QUERIES) {
    const started = Date.now();
    const result = await resolve(
      { query: query.query, k: config.resolution.k, mode: 'exact', scope: null, noEarlyExit: false },
      { registry, config, createClient, now: EVAL_NOW },
    );
    durations.push(Date.now() - started);

    if (result.hits.some((hit) => hit.documentId === query.expectedDocumentId)) recalled += 1;
    if (
      result.hits[0]?.documentId === query.expectedDocumentId &&
      result.hits[0]?.provenance.zone === query.expectedZone
    ) {
      authoritative += 1;
    }
  }

  const total = EVAL_QUERIES.length;
  return {
    queries: total,
    recallAtK: recalled / total,
    authorityAtOne: authoritative / total,
    fanoutRate: 0,
    p95ResolveMs: percentile95(durations),
    leakCount: 0,
  };
}

/**
 * Render a report as a Markdown readout.
 *
 * @param report - Harness result.
 * @param baseline - USER-only baseline for comparison.
 * @returns Markdown suitable for committing.
 */
export function formatReport(report: EvalReport, baseline: EvalMetrics): string {
  const percent = (value: number): string => `${(value * 100).toFixed(0)}%`;

  const lines = [
    '| Metric | Hierarchy | USER-only baseline |',
    '|--------|-----------|--------------------|',
    `| \`recall@k\` | ${percent(report.metrics.recallAtK)} | ${percent(baseline.recallAtK)} |`,
    `| \`authority@1\` | ${percent(report.metrics.authorityAtOne)} | ${percent(baseline.authorityAtOne)} |`,
    `| \`fanoutRate\` | ${percent(report.metrics.fanoutRate)} | 0% |`,
    `| \`p95ResolveMs\` | ${report.metrics.p95ResolveMs} | ${baseline.p95ResolveMs} |`,
    `| \`leakCount\` | ${report.metrics.leakCount} | 0 |`,
    '',
    '| Case | Top hit | Zone | Authoritative | Early exit |',
    '|------|---------|------|---------------|------------|',
    ...report.cases.map(
      (entry) =>
        `| ${entry.name} | \`${entry.topDocumentId ?? '—'}\` | ${entry.topZone ?? '—'} | ${
          entry.authoritative ? 'yes' : 'no'
        } | ${entry.earlyExitAt === null ? 'none' : `distance ${entry.earlyExitAt}`} |`,
    ),
  ];
  return lines.join('\n');
}
