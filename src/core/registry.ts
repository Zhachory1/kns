/**
 * The zone registry — the "root hints" of the DNS analogy.
 *
 * The registry is a local file listing the zones this machine knows about. It is
 * never fetched over the network: `transport.command` names a process to spawn, so a
 * remotely-supplied registry would be remote code execution with extra steps.
 *
 * Loading fails closed. A malformed registry loads no zones at all rather than a
 * subset, because a partially-loaded registry silently changes which zone is
 * authoritative — a failure that is easy to cause and hard to notice.
 *
 * @module
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SCHEMA_VERSION } from '../version.ts';
import { KnsError } from './errors.ts';
import type { Zone } from './types.ts';
import { issuesToError, parseZone } from './validate.ts';
import type { ValidationIssue, ValidationResult } from './validate.ts';

/** File name of the registry inside the KNS home directory. */
export const REGISTRY_FILE = 'zones.json';

/** A validated set of zones. */
export interface Registry {
  /** Wire schema version of the registry file. */
  schemaVersion: number;
  /** Zones, in the order they appear in the file. */
  zones: Zone[];
}

/**
 * Resolve the KNS home directory.
 *
 * @param env - Environment to read `KNS_HOME` from. Defaults to the process env.
 * @returns Absolute path to the KNS home directory.
 */
export function knsHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['KNS_HOME'];
  if (override !== undefined && override.trim() !== '') return path.resolve(override);
  return path.join(os.homedir(), '.kns');
}

/**
 * Parse a registry document.
 *
 * @param input - Untrusted value, typically parsed JSON.
 * @returns The validated registry, or the issues that blocked it.
 */
export function parseRegistry(input: unknown): ValidationResult<Registry> {
  const issues: ValidationIssue[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, issues: [{ path: 'registry', message: 'expected an object' }] };
  }

  const source = input as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (key !== 'schemaVersion' && key !== 'zones') {
      issues.push({ path: `registry.${key}`, message: 'unknown field' });
    }
  }

  const schemaVersion = source['schemaVersion'];
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    issues.push({ path: 'registry.schemaVersion', message: 'expected an integer' });
  } else if (schemaVersion !== SCHEMA_VERSION) {
    issues.push({
      path: 'registry.schemaVersion',
      message: `unsupported version ${schemaVersion}; this build understands ${SCHEMA_VERSION}`,
    });
  }

  const rawZones = source['zones'];
  if (!Array.isArray(rawZones)) {
    issues.push({ path: 'registry.zones', message: 'expected an array' });
    return { ok: false, issues };
  }

  const zones: Zone[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < rawZones.length; index += 1) {
    const parsed = parseZone(rawZones[index], `registry.zones[${index}]`);
    if (!parsed.ok) {
      issues.push(...parsed.issues);
      continue;
    }
    if (seen.has(parsed.value.name)) {
      issues.push({
        path: `registry.zones[${index}].name`,
        message: `duplicate zone name "${parsed.value.name}"`,
      });
      continue;
    }
    seen.add(parsed.value.name);
    zones.push(parsed.value);
  }

  issues.push(...validateDelegation(zones));

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { schemaVersion: SCHEMA_VERSION, zones } };
}

/** An empty registry, used when no registry file exists yet. */
export function emptyRegistry(): Registry {
  return { schemaVersion: SCHEMA_VERSION, zones: [] };
}

/**
 * Load the registry from disk.
 *
 * A missing file is not an error: a machine that has not added a zone yet simply has
 * no zones. Malformed content is an error, and no zone loads.
 *
 * @param home - KNS home directory.
 * @returns The validated registry.
 * @throws {KnsError} With code `registry_invalid` when the file cannot be parsed.
 */
export async function loadRegistry(home: string = knsHome()): Promise<Registry> {
  const file = path.join(home, REGISTRY_FILE);

  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return emptyRegistry();
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new KnsError(
      'registry_invalid',
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      'fix the JSON syntax, or delete the file to start over',
    );
  }

  const parsed = parseRegistry(json);
  if (!parsed.ok) throw issuesToError(parsed.issues, 'registry_invalid');
  return parsed.value;
}

/**
 * Write the registry to disk, creating the home directory when needed.
 *
 * @param home - KNS home directory.
 * @param registry - Registry to persist.
 */
export async function saveRegistry(home: string, registry: Registry): Promise<void> {
  await mkdir(home, { recursive: true });
  const file = path.join(home, REGISTRY_FILE);
  await writeFile(file, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}

/**
 * Find a zone by name.
 *
 * @param registry - Registry to search.
 * @param name - Zone name.
 * @returns The zone, or null when no zone has that name.
 */
export function findZone(registry: Registry, name: string): Zone | null {
  return registry.zones.find((zone) => zone.name === name) ?? null;
}

/**
 * Add a zone.
 *
 * @param registry - Registry to extend.
 * @param zone - Zone to add.
 * @returns A new registry including the zone.
 * @throws {KnsError} With code `invalid_request` when the name is already taken.
 */
export function addZone(registry: Registry, zone: Zone): Registry {
  if (findZone(registry, zone.name) !== null) {
    throw new KnsError(
      'invalid_request',
      `zone "${zone.name}" already exists`,
      'choose another name, or remove the existing zone first',
    );
  }
  return { schemaVersion: registry.schemaVersion, zones: [...registry.zones, zone] };
}

/**
 * Remove a zone by name.
 *
 * @param registry - Registry to reduce.
 * @param name - Zone name.
 * @returns A new registry without the zone.
 * @throws {KnsError} With code `invalid_request` when no zone has that name.
 */
export function removeZone(registry: Registry, name: string): Registry {
  if (findZone(registry, name) === null) {
    throw new KnsError('invalid_request', `no zone named "${name}"`, 'run kns zone list');
  }
  return {
    schemaVersion: registry.schemaVersion,
    zones: registry.zones.filter((zone) => zone.name !== name),
  };
}

/**
 * Report whether a namespace falls within a scope.
 *
 * Matching is per path segment, so `company/plat` does not match `company/platform`.
 * A prefix match on raw strings would silently widen a scoped query.
 *
 * @param namespace - Zone namespace.
 * @param scope - Namespace prefix, or null to match everything.
 * @returns True when the namespace is the scope or sits beneath it.
 */
export function namespaceMatches(namespace: string, scope: string | null): boolean {
  if (scope === null || scope === '') return true;

  const namespaceParts = namespace.split('/').filter((part) => part !== '');
  const scopeParts = scope.split('/').filter((part) => part !== '');
  if (scopeParts.length > namespaceParts.length) return false;

  return scopeParts.every((part, index) => namespaceParts[index] === part);
}

/**
 * Select the zones a query should reach, nearest first.
 *
 * @param registry - Registry to select from.
 * @param scope - Namespace prefix, or null for the whole tree.
 * @returns Matching zones sorted by distance, then by name for determinism.
 */
export function selectZones(registry: Registry, scope: string | null = null): Zone[] {
  const matched = registry.zones.filter((zone) => namespaceMatches(zone.namespace, scope));

  return expandDelegated(registry, matched)
    .sort((left, right) =>
      left.distance === right.distance
        ? left.name.localeCompare(right.name)
        : left.distance - right.distance,
    );
}

/** Deepest delegation chain allowed before the registry is rejected. */
export const MAX_DELEGATION_DEPTH = 8;

/**
 * Validate the delegation graph.
 *
 * Delegation is how a zone that outgrows its engine's corpus limits gets sharded, so
 * the graph is load-bearing. A cycle would make resolution non-terminating and an
 * unknown target would silently drop a shard, so both fail closed at load time rather
 * than surfacing as a missing answer later.
 *
 * @param zones - Zones to validate.
 * @returns Issues found, empty when the graph is sound.
 */
export function validateDelegation(zones: readonly Zone[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byName = new Map(zones.map((zone) => [zone.name, zone]));

  for (const zone of zones) {
    for (const target of zone.delegatesTo) {
      if (target === zone.name) {
        issues.push({ path: `registry.zones.${zone.name}.delegatesTo`, message: 'a zone cannot delegate to itself' });
        continue;
      }
      const child = byName.get(target);
      if (child === undefined) {
        issues.push({
          path: `registry.zones.${zone.name}.delegatesTo`,
          message: `delegates to unknown zone "${target}"`,
        });
        continue;
      }
      if (!namespaceMatches(child.namespace, zone.namespace)) {
        issues.push({
          path: `registry.zones.${zone.name}.delegatesTo`,
          message: `"${target}" (${child.namespace}) is not beneath ${zone.namespace}`,
        });
      }
    }
  }

  const state = new Map<string, 'visiting' | 'done'>();

  const walk = (name: string, depth: number, trail: string[]): void => {
    if (depth > MAX_DELEGATION_DEPTH) {
      issues.push({
        path: `registry.zones.${name}.delegatesTo`,
        message: `delegation deeper than ${MAX_DELEGATION_DEPTH}: ${trail.join(' -> ')}`,
      });
      return;
    }
    if (state.get(name) === 'visiting') {
      issues.push({
        path: `registry.zones.${name}.delegatesTo`,
        message: `delegation cycle: ${[...trail, name].join(' -> ')}`,
      });
      return;
    }
    if (state.get(name) === 'done') return;

    state.set(name, 'visiting');
    for (const target of byName.get(name)?.delegatesTo ?? []) {
      if (byName.has(target)) walk(target, depth + 1, [...trail, name]);
    }
    state.set(name, 'done');
  };

  for (const zone of zones) walk(zone.name, 0, []);
  return issues;
}

/**
 * Expand a set of zones to include everything they delegate to.
 *
 * A scoped query names a zone by namespace; the shards beneath it are part of the same
 * answer, so selecting the parent must select the children too. Otherwise sharding a
 * zone would silently shrink what a scoped query can find.
 *
 * @param registry - Registry to expand within.
 * @param selected - Zones already selected.
 * @returns The selection plus every zone reachable through delegation.
 */
export function expandDelegated(registry: Registry, selected: readonly Zone[]): Zone[] {
  const byName = new Map(registry.zones.map((zone) => [zone.name, zone]));
  const result = new Map(selected.map((zone) => [zone.name, zone]));
  const queue = [...selected];

  while (queue.length > 0) {
    const zone = queue.shift();
    if (zone === undefined) continue;
    for (const target of zone.delegatesTo) {
      const child = byName.get(target);
      if (child === undefined || result.has(child.name)) continue;
      result.set(child.name, child);
      queue.push(child);
    }
  }

  return [...result.values()];
}

/**
 * Group zones into distance bands.
 *
 * Zones within a band are queried in parallel; bands are walked in order, which is
 * what makes resolution "nearest first, then outward".
 *
 * @param zones - Zones sorted by distance, as returned by {@link selectZones}.
 * @returns One array per distinct distance, in ascending order.
 */
export function groupByDistance(zones: readonly Zone[]): Zone[][] {
  const groups: Zone[][] = [];
  let current: Zone[] = [];
  let distance: number | null = null;

  for (const zone of zones) {
    if (distance === null || zone.distance === distance) {
      current.push(zone);
      distance = zone.distance;
      continue;
    }
    groups.push(current);
    current = [zone];
    distance = zone.distance;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}
