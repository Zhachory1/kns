/**
 * Resolution, ranking, and early-exit settings.
 *
 * Every tunable lives here with a documented default and a validated range. Defaults
 * are deliberately conservative — they fan out more than necessary — because the
 * honest values come from the eval harness, not from intuition.
 *
 * @module
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { SCHEMA_VERSION } from '../version.ts';
import { KnsError } from './errors.ts';
import { issuesToError } from './validate.ts';
import type { ValidationIssue, ValidationResult } from './validate.ts';

/** File name of the settings document inside the KNS home directory. */
export const CONFIG_FILE = 'config.json';

/** How far and how long a resolution may reach. */
export interface ResolutionConfig {
  /** Hits returned to the caller. */
  k: number;
  /** Per-zone deadline in milliseconds. Zones that exceed it are dropped. */
  zoneDeadlineMs: number;
  /** Overall deadline in milliseconds. */
  resolveDeadlineMs: number;
  /** Maximum zones queried simultaneously. */
  maxConcurrentZones: number;
}

/** Weights for the fusion and the priors applied on top of it. */
export interface RankingConfig {
  /** Reciprocal Rank Fusion constant. Larger values flatten rank differences. */
  rrfK: number;
  /** Nearness prior is `nearnessBase ** distance`. */
  nearnessBase: number;
  /** Multiplier applied to shared documents with no owner. */
  unownedPenalty: number;
  /** Multiplier applied to documents past their review date. */
  staleFactor: number;
  /** Floor for the query-coverage factor, so a terse snippet is not zeroed out. */
  coverageFloor: number;
}

/** When the resolution walk may stop before reaching every zone. */
export interface EarlyExitConfig {
  /** Minimum normalised margin of the top hit over the runner-up. */
  marginMin: number;
  /** Oldest a top hit may be, in days, and still stop the walk. */
  authoritativeMaxAgeDays: number;
  /** Minimum hits at a distance before the walk may stop there. */
  minHits: number;
}

/** All settings. */
export interface KnsConfig {
  /** Wire schema version of the settings document. */
  schemaVersion: number;
  /** Resolution limits. */
  resolution: ResolutionConfig;
  /** Ranking weights. */
  ranking: RankingConfig;
  /** Early-exit policy. */
  earlyExit: EarlyExitConfig;
}

/** Accepted range for each numeric setting. */
const RANGES: Record<string, Record<string, { min: number; max: number; integer: boolean }>> = {
  resolution: {
    k: { min: 1, max: 20, integer: true },
    zoneDeadlineMs: { min: 50, max: 120_000, integer: true },
    resolveDeadlineMs: { min: 50, max: 300_000, integer: true },
    maxConcurrentZones: { min: 1, max: 32, integer: true },
  },
  ranking: {
    rrfK: { min: 1, max: 1000, integer: false },
    nearnessBase: { min: 0.1, max: 1, integer: false },
    unownedPenalty: { min: 0.1, max: 1, integer: false },
    staleFactor: { min: 0.05, max: 1, integer: false },
    coverageFloor: { min: 0, max: 1, integer: false },
  },
  earlyExit: {
    marginMin: { min: 0, max: 1, integer: false },
    authoritativeMaxAgeDays: { min: 1, max: 36_500, integer: false },
    minHits: { min: 1, max: 20, integer: true },
  },
};

/**
 * Settings used when no configuration file exists.
 *
 * @returns A fresh copy, safe for the caller to mutate.
 */
export function defaultConfig(): KnsConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
    resolution: { k: 10, zoneDeadlineMs: 1500, resolveDeadlineMs: 4000, maxConcurrentZones: 4 },
    // rrfK is 10, not the textbook 60. RRF's usual constant assumes many rankers over
    // one corpus; here there are a handful of zones, and at k=60 adjacent ranks differ
    // by so little that the nearness prior decides every comparison — a rank-9 local note
    // outscores a rank-1 fresh company document, which makes nearness an override
    // rather than a prior. PR-11 tunes this against the harness.
    ranking: { rrfK: 10, nearnessBase: 0.9, unownedPenalty: 0.85, staleFactor: 0.5, coverageFloor: 0.3 },
    earlyExit: { marginMin: 0.15, authoritativeMaxAgeDays: 90, minHits: 1 },
  };
}

/** Merge one validated section over its defaults. */
function mergeSection(
  issues: ValidationIssue[],
  section: string,
  defaults: Record<string, number>,
  input: unknown,
): Record<string, number> {
  if (input === undefined) return { ...defaults };
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    issues.push({ path: `config.${section}`, message: 'expected an object' });
    return { ...defaults };
  }

  const merged = { ...defaults };
  const ranges = RANGES[section] ?? {};

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const range = ranges[key];
    if (range === undefined) {
      issues.push({ path: `config.${section}.${key}`, message: 'unknown field' });
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issues.push({ path: `config.${section}.${key}`, message: 'expected a finite number' });
      continue;
    }
    if (range.integer && !Number.isInteger(value)) {
      issues.push({ path: `config.${section}.${key}`, message: 'expected an integer' });
      continue;
    }
    if (value < range.min || value > range.max) {
      issues.push({
        path: `config.${section}.${key}`,
        message: `expected a value between ${range.min} and ${range.max}`,
      });
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

/**
 * Parse a settings document, filling in defaults for anything absent.
 *
 * @param input - Untrusted value, typically parsed JSON.
 * @returns The merged settings, or the issues that blocked them.
 */
export function parseConfig(input: unknown): ValidationResult<KnsConfig> {
  const defaults = defaultConfig();
  if (input === undefined || input === null) return { ok: true, value: defaults };

  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, issues: [{ path: 'config', message: 'expected an object' }] };
  }

  const source = input as Record<string, unknown>;
  const issues: ValidationIssue[] = [];

  for (const key of Object.keys(source)) {
    if (!['schemaVersion', 'resolution', 'ranking', 'earlyExit'].includes(key)) {
      issues.push({ path: `config.${key}`, message: 'unknown field' });
    }
  }

  const schemaVersion = source['schemaVersion'];
  if (schemaVersion !== undefined && schemaVersion !== SCHEMA_VERSION) {
    issues.push({
      path: 'config.schemaVersion',
      message: `unsupported version ${String(schemaVersion)}; this build understands ${SCHEMA_VERSION}`,
    });
  }

  const resolution = mergeSection(issues, 'resolution', defaults.resolution as unknown as Record<string, number>, source['resolution']);
  const ranking = mergeSection(issues, 'ranking', defaults.ranking as unknown as Record<string, number>, source['ranking']);
  const earlyExit = mergeSection(issues, 'earlyExit', defaults.earlyExit as unknown as Record<string, number>, source['earlyExit']);

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    value: {
      schemaVersion: SCHEMA_VERSION,
      resolution: resolution as unknown as ResolutionConfig,
      ranking: ranking as unknown as RankingConfig,
      earlyExit: earlyExit as unknown as EarlyExitConfig,
    },
  };
}

/**
 * Load settings from the KNS home directory.
 *
 * A missing file yields the defaults. A malformed one is an error: silently falling
 * back to defaults would change ranking behaviour without telling anyone.
 *
 * @param home - KNS home directory.
 * @returns The merged settings.
 * @throws {KnsError} With code `invalid_request` when the file cannot be parsed.
 */
export async function loadConfig(home: string): Promise<KnsConfig> {
  const file = path.join(home, CONFIG_FILE);

  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return defaultConfig();
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new KnsError(
      'invalid_request',
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      'fix the JSON syntax, or delete the file to use defaults',
    );
  }

  const parsed = parseConfig(json);
  if (!parsed.ok) throw issuesToError(parsed.issues);
  return parsed.value;
}
