/**
 * Runtime validation for everything that crosses a trust boundary.
 *
 * Two inputs are never trusted: the zone registry on disk, and requests arriving from
 * a CLI user or an MCP client. Both are parsed here rather than cast.
 *
 * Unknown keys are rejected rather than ignored. A typo in a registry entry would
 * otherwise silently fall back to a default, quietly changing which zone is
 * authoritative — a failure that is hard to notice and easy to misdiagnose.
 *
 * @module
 */

import { KnsError } from './errors.ts';
import type { ErrorCode } from './errors.ts';
import { RESOLVE_MODES, TIERS, TRANSPORT_KINDS } from './types.ts';
import type { ResolveMode, ResolveRequest, Tier, Transport, TransportKind, Zone } from './types.ts';

/** One validation failure, located by a dotted path. */
export interface ValidationIssue {
  /** Dotted path to the offending field, e.g. `zones[0].transport.kind`. */
  path: string;
  /** What is wrong with it. */
  message: string;
}

/** The outcome of parsing untrusted input. */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] };

/** Smallest accepted value for `k`. */
export const K_MIN = 1;

/** Largest accepted value for `k`, matching the MCP bound. */
export const K_MAX = 20;

/** Longest accepted query, in characters. */
export const QUERY_MAX = 1000;

/** Default freshness half-life, in days, when a zone does not specify one. */
export const DEFAULT_HALF_LIFE_DAYS = 365;

/** Collects issues while walking a structure. */
interface Context {
  issues: ValidationIssue[];
}

/** Record a failure at a path. */
function fail(context: Context, path: string, message: string): void {
  context.issues.push({ path, message });
}

/** Read a required string field. */
function readString(context: Context, source: Record<string, unknown>, path: string, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') {
    fail(context, `${path}.${key}`, 'expected a non-empty string');
    return '';
  }
  return value;
}

/** Read an optional string field that may be explicitly null. */
function readNullableString(
  context: Context,
  source: Record<string, unknown>,
  path: string,
  key: string,
): string | null {
  const value = source[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    fail(context, `${path}.${key}`, 'expected a non-empty string or null');
    return null;
  }
  return value;
}

/** Read a numeric field with bounds, falling back to a default when absent. */
function readNumber(
  context: Context,
  source: Record<string, unknown>,
  path: string,
  key: string,
  options: { min: number; max: number; integer: boolean; fallback?: number },
): number {
  const value = source[key];
  if (value === undefined) {
    if (options.fallback !== undefined) return options.fallback;
    fail(context, `${path}.${key}`, 'is required');
    return 0;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(context, `${path}.${key}`, 'expected a finite number');
    return 0;
  }
  if (options.integer && !Number.isInteger(value)) {
    fail(context, `${path}.${key}`, 'expected an integer');
    return 0;
  }
  if (value < options.min || value > options.max) {
    fail(context, `${path}.${key}`, `expected a value between ${options.min} and ${options.max}`);
    return 0;
  }
  return value;
}

/** Read a boolean field, falling back when absent. */
function readBoolean(
  context: Context,
  source: Record<string, unknown>,
  path: string,
  key: string,
  fallback: boolean,
): boolean {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    fail(context, `${path}.${key}`, 'expected a boolean');
    return fallback;
  }
  return value;
}

/** Read a value constrained to a fixed set. */
function readEnum<T extends string>(
  context: Context,
  source: Record<string, unknown>,
  path: string,
  key: string,
  allowed: readonly T[],
  fallback?: T,
): T {
  const value = source[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(context, `${path}.${key}`, `expected one of: ${allowed.join(', ')}`);
    return (fallback ?? allowed[0]) as T;
  }
  return value as T;
}

/** Read an array of strings. */
function readStringArray(
  context: Context,
  source: Record<string, unknown>,
  path: string,
  key: string,
): string[] {
  const value = source[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail(context, `${path}.${key}`, 'expected an array of strings');
    return [];
  }
  return value as string[];
}

/** Report any key that is not part of the schema. */
function rejectUnknownKeys(
  context: Context,
  source: Record<string, unknown>,
  path: string,
  known: readonly string[],
): void {
  for (const key of Object.keys(source)) {
    if (!known.includes(key)) {
      fail(context, `${path}.${key}`, 'unknown field');
    }
  }
}

/** Narrow a value to a plain object. */
function asRecord(
  context: Context,
  value: unknown,
  path: string,
): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(context, path, 'expected an object');
    return null;
  }
  return value as Record<string, unknown>;
}

/** Fields a transport may declare. */
const TRANSPORT_KEYS = ['kind', 'command', 'args'] as const;

/** Fields a zone may declare. */
const ZONE_KEYS = [
  'name',
  'namespace',
  'tier',
  'distance',
  'transport',
  'ttlSeconds',
  'halfLifeDays',
  'owner',
  'sourceRepo',
  'neverEarlyExit',
  'delegatesTo',
] as const;

/** Fields a resolve request may declare. */
const RESOLVE_KEYS = ['query', 'k', 'mode', 'scope', 'noEarlyExit'] as const;

/**
 * Parse a zone transport.
 *
 * @param input - Untrusted value.
 * @param path - Dotted path used in issue messages.
 * @returns The parsed transport, or the issues that blocked it.
 */
export function parseTransport(input: unknown, path = 'transport'): ValidationResult<Transport> {
  const context: Context = { issues: [] };
  const source = asRecord(context, input, path);
  if (source === null) return { ok: false, issues: context.issues };

  rejectUnknownKeys(context, source, path, TRANSPORT_KEYS);
  const kind = readEnum<TransportKind>(context, source, path, 'kind', TRANSPORT_KINDS);
  const command = readString(context, source, path, 'command');
  const args = readStringArray(context, source, path, 'args');

  if (context.issues.length > 0) return { ok: false, issues: context.issues };
  return { ok: true, value: { kind, command, args } };
}

/**
 * Parse a zone registry entry.
 *
 * @param input - Untrusted value.
 * @param path - Dotted path used in issue messages.
 * @returns The parsed zone, or the issues that blocked it.
 */
export function parseZone(input: unknown, path = 'zone'): ValidationResult<Zone> {
  const context: Context = { issues: [] };
  const source = asRecord(context, input, path);
  if (source === null) return { ok: false, issues: context.issues };

  rejectUnknownKeys(context, source, path, ZONE_KEYS);

  const name = readString(context, source, path, 'name');
  const namespace = readString(context, source, path, 'namespace');
  const tier = readEnum<Tier>(context, source, path, 'tier', TIERS);
  const distance = readNumber(context, source, path, 'distance', {
    min: 0,
    max: 64,
    integer: true,
  });
  const ttlSeconds = readNumber(context, source, path, 'ttlSeconds', {
    min: 0,
    max: 31_536_000,
    integer: true,
    fallback: 0,
  });
  const halfLifeDays = readNumber(context, source, path, 'halfLifeDays', {
    min: 0.5,
    max: 36_500,
    integer: false,
    fallback: DEFAULT_HALF_LIFE_DAYS,
  });
  const owner = readNullableString(context, source, path, 'owner');
  const sourceRepo = readNullableString(context, source, path, 'sourceRepo');
  const neverEarlyExit = readBoolean(context, source, path, 'neverEarlyExit', false);
  const delegatesTo = readStringArray(context, source, path, 'delegatesTo');

  const transport = parseTransport(source['transport'], `${path}.transport`);
  if (!transport.ok) context.issues.push(...transport.issues);

  if (context.issues.length > 0 || !transport.ok) {
    return { ok: false, issues: context.issues };
  }

  return {
    ok: true,
    value: {
      name,
      namespace,
      tier,
      distance,
      transport: transport.value,
      ttlSeconds,
      halfLifeDays,
      owner,
      sourceRepo,
      neverEarlyExit,
      delegatesTo,
    },
  };
}

/**
 * Parse a resolution request from a CLI user or an MCP client.
 *
 * Out-of-range values are rejected rather than clamped, so a caller never silently
 * receives something other than what it asked for.
 *
 * @param input - Untrusted value.
 * @param path - Dotted path used in issue messages.
 * @returns The parsed request, or the issues that blocked it.
 */
export function parseResolveRequest(
  input: unknown,
  path = 'request',
): ValidationResult<ResolveRequest> {
  const context: Context = { issues: [] };
  const source = asRecord(context, input, path);
  if (source === null) return { ok: false, issues: context.issues };

  rejectUnknownKeys(context, source, path, RESOLVE_KEYS);

  const query = readString(context, source, path, 'query');
  if (query.length > QUERY_MAX) {
    fail(context, `${path}.query`, `expected at most ${QUERY_MAX} characters`);
  }

  const k = readNumber(context, source, path, 'k', {
    min: K_MIN,
    max: K_MAX,
    integer: true,
    fallback: 10,
  });
  const mode = readEnum<ResolveMode>(context, source, path, 'mode', RESOLVE_MODES, 'exact');
  const scope = readNullableString(context, source, path, 'scope');
  const noEarlyExit = readBoolean(context, source, path, 'noEarlyExit', false);

  if (context.issues.length > 0) return { ok: false, issues: context.issues };
  return { ok: true, value: { query, k, mode, scope, noEarlyExit } };
}

/**
 * Convert validation issues into a thrown-ready error.
 *
 * @param issues - Issues collected during parsing.
 * @param code - Error code to report; registry parsing uses `registry_invalid`.
 * @returns An error naming every offending path.
 */
export function issuesToError(
  issues: readonly ValidationIssue[],
  code: ErrorCode = 'invalid_request',
): KnsError {
  const detail = issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
  return new KnsError(code, `validation failed — ${detail}`, 'correct the reported fields');
}
