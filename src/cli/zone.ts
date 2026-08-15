/**
 * The `kns zone` command family: inspect and edit the zone registry.
 *
 * @module
 */

import path from 'node:path';

import { KnsError, ok } from '../core/errors.ts';
import {
  addZone,
  findZone,
  loadRegistry,
  removeZone,
  saveRegistry,
  selectZones,
} from '../core/registry.ts';
import type { Zone } from '../core/types.ts';
import { issuesToError, parseZone } from '../core/validate.ts';
import { flagBoolean, flagNumber, flagString, unknownFlags } from './args.ts';
import type { ParsedArgs } from './args.ts';

/** Ambient dependencies a command needs, injected so tests never touch the real home. */
export interface CliContext {
  /** KNS home directory. */
  home: string;
  /** Sink for command output. */
  write: (text: string) => void;
}

/** Flags accepted by `kns zone add`. */
const ADD_FLAGS = [
  'json',
  'name',
  'namespace',
  'tier',
  'distance',
  'root',
  'command',
  'arg',
  'ttl-seconds',
  'half-life-days',
  'owner',
  'source-repo',
  'never-early-exit',
];

/** Flags accepted by the read-only zone commands. */
const READ_FLAGS = ['json', 'scope'];

/** Render a zone for human-readable output. */
function describeZone(zone: Zone): string {
  const owner = zone.owner ?? 'unowned';
  const target = zone.transport.args.join(' ');
  return `${zone.name}  d=${zone.distance}  ${zone.tier}  ${zone.namespace}  (${owner})  ${zone.transport.command} ${target}`;
}

/** Reject flags the subcommand does not understand. */
function assertKnownFlags(args: ParsedArgs, known: readonly string[]): void {
  const unknown = unknownFlags(args, known);
  if (unknown.length > 0) {
    throw new KnsError(
      'invalid_request',
      `unknown flag(s): ${unknown.map((name) => `--${name}`).join(', ')}`,
      'run kns zone --help',
    );
  }
}

/** Build a zone from `kns zone add` flags, validating it like any untrusted input. */
function zoneFromFlags(args: ParsedArgs): Zone {
  const root = flagString(args, 'root');
  const command = flagString(args, 'command') ?? 'zbrain-mcp';

  const explicitArg = args.flags.get('arg');
  const transportArgs =
    root !== null
      ? ['--root', path.resolve(root)]
      : typeof explicitArg === 'string'
        ? explicitArg.split(' ').filter((part) => part !== '')
        : [];

  const candidate: Record<string, unknown> = {
    name: flagString(args, 'name') ?? '',
    namespace: flagString(args, 'namespace') ?? '',
    tier: flagString(args, 'tier') ?? '',
    distance: flagNumber(args, 'distance') ?? undefined,
    transport: { kind: 'stdio', command, args: transportArgs },
    neverEarlyExit: flagBoolean(args, 'never-early-exit'),
  };

  const ttl = flagNumber(args, 'ttl-seconds');
  if (ttl !== null) candidate['ttlSeconds'] = ttl;
  const halfLife = flagNumber(args, 'half-life-days');
  if (halfLife !== null) candidate['halfLifeDays'] = halfLife;
  const owner = flagString(args, 'owner');
  if (owner !== null) candidate['owner'] = owner;
  const sourceRepo = flagString(args, 'source-repo');
  if (sourceRepo !== null) candidate['sourceRepo'] = sourceRepo;

  const parsed = parseZone(candidate, 'zone');
  if (!parsed.ok) throw issuesToError(parsed.issues);
  return parsed.value;
}

/**
 * Run a `kns zone` subcommand.
 *
 * @param args - Parsed command line, positional `['zone', subcommand, ...]`.
 * @param context - Injected home directory and output sink.
 * @returns Zero on success. Failures throw {@link KnsError} for the caller to render.
 */
export async function runZone(args: ParsedArgs, context: CliContext): Promise<number> {
  const subcommand = args.positional[1] ?? 'list';
  const json = flagBoolean(args, 'json');

  if (subcommand === 'list') {
    assertKnownFlags(args, READ_FLAGS);
    const registry = await loadRegistry(context.home);
    const zones = selectZones(registry, flagString(args, 'scope'));

    if (json) {
      context.write(JSON.stringify(ok({ zones }), null, 2));
    } else if (zones.length === 0) {
      context.write('no zones configured — add one with: kns zone add --name ... --root ...');
    } else {
      context.write(zones.map(describeZone).join('\n'));
    }
    return 0;
  }

  if (subcommand === 'show') {
    assertKnownFlags(args, READ_FLAGS);
    const name = args.positional[2];
    if (name === undefined) {
      throw new KnsError('invalid_request', 'zone name is required', 'kns zone show <name>');
    }

    const registry = await loadRegistry(context.home);
    const zone = findZone(registry, name);
    if (zone === null) {
      throw new KnsError('invalid_request', `no zone named "${name}"`, 'run kns zone list');
    }

    context.write(json ? JSON.stringify(ok({ zone }), null, 2) : describeZone(zone));
    return 0;
  }

  if (subcommand === 'add') {
    assertKnownFlags(args, ADD_FLAGS);
    const zone = zoneFromFlags(args);
    const registry = await loadRegistry(context.home);
    const updated = addZone(registry, zone);
    await saveRegistry(context.home, updated);

    context.write(json ? JSON.stringify(ok({ zone }), null, 2) : `added zone ${zone.name}`);
    return 0;
  }

  if (subcommand === 'remove') {
    assertKnownFlags(args, READ_FLAGS);
    const name = args.positional[2];
    if (name === undefined) {
      throw new KnsError('invalid_request', 'zone name is required', 'kns zone remove <name>');
    }

    const registry = await loadRegistry(context.home);
    const updated = removeZone(registry, name);
    await saveRegistry(context.home, updated);

    context.write(json ? JSON.stringify(ok({ removed: name }), null, 2) : `removed zone ${name}`);
    return 0;
  }

  throw new KnsError(
    'invalid_request',
    `unknown subcommand "zone ${subcommand}"`,
    'expected one of: list, show, add, remove',
  );
}
