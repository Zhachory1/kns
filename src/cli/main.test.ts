import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { REGISTRY_FILE } from '../core/registry.ts';
import { VERSION } from '../version.ts';
import { USAGE, exitCodeFor, run } from './main.ts';

/** Run the CLI against a throwaway home directory, capturing output. */
async function cli(
  argv: string[],
  home?: string,
): Promise<{ code: number; out: string; err: string; home: string }> {
  const resolvedHome = home ?? (await mkdtemp(path.join(tmpdir(), 'kns-cli-')));
  const out: string[] = [];
  const err: string[] = [];

  const code = await run(argv, {
    home: resolvedHome,
    write: (text) => out.push(text),
    writeError: (text) => err.push(text),
  });

  return { code, out: out.join('\n'), err: err.join('\n'), home: resolvedHome };
}

test('exitCodeFor separates refusals from request errors and internal faults', () => {
  assert.equal(exitCodeFor('invalid_request'), 1);
  assert.equal(exitCodeFor('registry_invalid'), 1);
  assert.equal(exitCodeFor('zone_timeout'), 1);
  assert.equal(exitCodeFor('sanitizer_blocked'), 2);
  assert.equal(exitCodeFor('internal'), 3);
});

test('no arguments prints usage and succeeds', async () => {
  const result = await cli([]);
  assert.equal(result.code, 0);
  assert.equal(result.out, USAGE);
});

test('--version prints the version banner', async () => {
  const result = await cli(['--version']);
  assert.equal(result.code, 0);
  assert.match(result.out, new RegExp(`kns ${VERSION.replace(/\./g, '\\.')}`));
});

test('help is available as a command and as a flag', async () => {
  assert.equal((await cli(['help'])).out, USAGE);
  assert.equal((await cli(['zone', '--help'])).out, USAGE);
});

test('an unknown command fails with exit code 1', async () => {
  const result = await cli(['frobnicate']);
  assert.equal(result.code, 1);
  assert.match(result.err, /unknown command "frobnicate"/);
  assert.match(result.err, /next: run kns help/);
});

test('zone list reports an empty registry helpfully', async () => {
  const result = await cli(['zone', 'list']);
  assert.equal(result.code, 0);
  assert.match(result.out, /no zones configured/);
});

test('zone add validates, persists, and is visible to zone list', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'kns-cli-'));

  const added = await cli(
    [
      'zone',
      'add',
      '--name',
      'team-platform',
      '--namespace',
      'company/platform',
      '--tier',
      'TEAM',
      '--distance',
      '1',
      '--root',
      '/zones/platform',
      '--ttl-seconds',
      '3600',
      '--owner',
      'platform-team',
    ],
    home,
  );
  assert.equal(added.code, 0);
  assert.match(added.out, /added zone team-platform/);

  const onDisk = JSON.parse(await readFile(path.join(home, REGISTRY_FILE), 'utf8')) as {
    zones: { name: string; ttlSeconds: number; transport: { args: string[] } }[];
  };
  assert.equal(onDisk.zones[0]?.name, 'team-platform');
  assert.equal(onDisk.zones[0]?.ttlSeconds, 3600);
  assert.deepEqual(onDisk.zones[0]?.transport.args, ['--root', path.resolve('/zones/platform')]);

  const listed = await cli(['zone', 'list'], home);
  assert.match(listed.out, /team-platform\s+d=1\s+TEAM\s+company\/platform\s+\(platform-team\)/);
});

test('zone add rejects an invalid tier without writing anything', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'kns-cli-'));

  const result = await cli(
    ['zone', 'add', '--name', 'x', '--namespace', 'x', '--tier', 'DEPARTMENT', '--distance', '1', '--root', '/x'],
    home,
  );

  assert.equal(result.code, 1);
  assert.match(result.err, /zone\.tier/);
  assert.equal((await cli(['zone', 'list'], home)).out.includes('no zones configured'), true);
});

test('zone add rejects a duplicate name', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'kns-cli-'));
  const add = ['zone', 'add', '--name', 'user', '--namespace', 'user', '--tier', 'USER', '--distance', '0', '--root', '/docs'];

  assert.equal((await cli(add, home)).code, 0);
  const second = await cli(add, home);
  assert.equal(second.code, 1);
  assert.match(second.err, /already exists/);
});

test('zone show and remove operate by name', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'kns-cli-'));
  await cli(
    ['zone', 'add', '--name', 'user', '--namespace', 'user', '--tier', 'USER', '--distance', '0', '--root', '/docs'],
    home,
  );

  const shown = await cli(['zone', 'show', 'user', '--json'], home);
  assert.equal(shown.code, 0);
  const payload = JSON.parse(shown.out) as { ok: boolean; result: { zone: { name: string } } };
  assert.equal(payload.ok, true);
  assert.equal(payload.result.zone.name, 'user');

  assert.equal((await cli(['zone', 'remove', 'user'], home)).code, 0);
  assert.equal((await cli(['zone', 'show', 'user'], home)).code, 1);
});

test('zone show and remove require a name', async () => {
  assert.match((await cli(['zone', 'show'])).err, /zone name is required/);
  assert.match((await cli(['zone', 'remove'])).err, /zone name is required/);
});

test('zone remove rejects an unknown name', async () => {
  const result = await cli(['zone', 'remove', 'ghost']);
  assert.equal(result.code, 1);
  assert.match(result.err, /no zone named "ghost"/);
});

test('an unknown zone subcommand is rejected', async () => {
  const result = await cli(['zone', 'teleport']);
  assert.equal(result.code, 1);
  assert.match(result.err, /unknown subcommand "zone teleport"/);
});

test('unknown flags are reported rather than ignored', async () => {
  const result = await cli(['zone', 'list', '--scoop', 'company']);
  assert.equal(result.code, 1);
  assert.match(result.err, /unknown flag\(s\): --scoop/);
});

test('--json renders failures as an envelope on stderr', async () => {
  const result = await cli(['zone', 'remove', 'ghost', '--json']);

  assert.equal(result.code, 1);
  const envelope = JSON.parse(result.err) as {
    ok: boolean;
    error: { code: string; retryable: boolean };
  };
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, 'invalid_request');
  assert.equal(envelope.error.retryable, false);
});

test('zone list --json filters by scope', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'kns-cli-'));
  await cli(
    ['zone', 'add', '--name', 'user', '--namespace', 'user', '--tier', 'USER', '--distance', '0', '--root', '/docs'],
    home,
  );
  await cli(
    [
      'zone', 'add', '--name', 'team', '--namespace', 'company/platform',
      '--tier', 'TEAM', '--distance', '1', '--root', '/zones/platform',
    ],
    home,
  );

  const scoped = await cli(['zone', 'list', '--scope', 'company/platform', '--json'], home);
  const payload = JSON.parse(scoped.out) as { result: { zones: { name: string }[] } };
  assert.deepEqual(
    payload.result.zones.map((zone) => zone.name),
    ['team'],
  );
});

test('zone add accepts an explicit command and argument string', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'kns-cli-'));
  const result = await cli(
    [
      'zone', 'add', '--name', 'custom', '--namespace', 'custom', '--tier', 'USER',
      // A value that itself begins with dashes must use the = form; a bare
      // `--arg --root ...` is parsed as a switch followed by another flag.
      '--distance', '0', '--command', 'my-mcp', '--arg=--root /elsewhere',
    ],
    home,
  );

  assert.equal(result.code, 0);
  const shown = await cli(['zone', 'show', 'custom', '--json'], home);
  const payload = JSON.parse(shown.out) as {
    result: { zone: { transport: { command: string; args: string[] } } };
  };
  assert.equal(payload.result.zone.transport.command, 'my-mcp');
  assert.deepEqual(payload.result.zone.transport.args, ['--root', '/elsewhere']);
});

test('a corrupt registry fails closed rather than loading a subset', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'kns-cli-'));
  await (await import('node:fs/promises')).writeFile(
    path.join(home, REGISTRY_FILE),
    '{ "schemaVersion": 1, "zones": [ { "name": "broken" } ] }',
    'utf8',
  );

  const result = await cli(['zone', 'list'], home);
  assert.equal(result.code, 1);
  assert.match(result.err, /registry_invalid|validation failed/);
});
