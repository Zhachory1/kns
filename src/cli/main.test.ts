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

/** Register a zone backed by the controllable fake server. */
async function homeWithFakeZone(mode = 'ok'): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'kns-cli-'));
  const server = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../../fixtures/fake-zone/server.mjs',
  );

  const added = await cli(
    [
      'zone', 'add', '--name', 'user', '--namespace', 'user', '--tier', 'USER',
      '--distance', '0', '--command', process.execPath, `--arg=${server} --mode ${mode}`,
    ],
    home,
  );
  assert.equal(added.code, 0, added.err);
  return home;
}

test('resolve requires a query', async () => {
  const result = await cli(['resolve']);
  assert.equal(result.code, 1);
  assert.match(result.err, /query is required/);
});

test('resolve rejects an out-of-range k rather than clamping it', async () => {
  const result = await cli(['resolve', 'anything', '--k', '99']);
  assert.equal(result.code, 1);
  assert.match(result.err, /request\.k/);
});

test('resolve rejects unknown flags', async () => {
  const result = await cli(['resolve', 'anything', '--scoop', 'x']);
  assert.equal(result.code, 1);
  assert.match(result.err, /unknown flag\(s\): --scoop/);
});

test('resolve returns annotated hits from a live zone', async () => {
  const home = await homeWithFakeZone();
  const result = await cli(['resolve', 'index', 'reload', '--json'], home);

  assert.equal(result.code, 0, result.err);
  const payload = JSON.parse(result.out) as {
    result: {
      hits: { documentId: string; provenance: { zone: string; tier: string } }[];
      zonesQueried: string[];
      partial: boolean;
    };
  };

  assert.deepEqual(payload.result.zonesQueried, ['user']);
  assert.equal(payload.result.partial, false);
  assert.equal(payload.result.hits[0]?.documentId, 'concepts/hot-index-reload.md');
  assert.equal(payload.result.hits[0]?.provenance.zone, 'user');
  assert.equal(payload.result.hits[0]?.provenance.tier, 'USER');
});

test('resolve renders hits for humans', async () => {
  const home = await homeWithFakeZone();
  const result = await cli(['resolve', 'index reload'], home);

  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /1\. concepts\/hot-index-reload\.md/);
  assert.match(result.out, /USER user d=0/);
  assert.match(result.out, /zones: user/);
});

test('a failing zone degrades the result instead of failing the command', async () => {
  const home = await homeWithFakeZone('crash');
  const result = await cli(['resolve', 'anything', '--json'], home);

  assert.equal(result.code, 0, 'a dead zone must not fail the query');
  const payload = JSON.parse(result.out) as {
    result: { hits: unknown[]; partial: boolean; warnings: { code: string }[] };
  };
  assert.deepEqual(payload.result.hits, []);
  assert.equal(payload.result.partial, true);
  assert.equal(payload.result.warnings[0]?.code, 'zone_unavailable');
});

test('resolve reports an empty registry as a warning, not a failure', async () => {
  const result = await cli(['resolve', 'anything']);
  assert.equal(result.code, 0);
  assert.match(result.out, /no hits/);
  assert.match(result.out, /no zones configured/);
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

test('promote suggest requires a USER zone with a root', async () => {
  const noZone = await cli(['promote', 'suggest']);
  assert.equal(noZone.code, 1);
  assert.match(noZone.err, /no USER zone is configured/);
});

test('promote suggest ranks candidates and writes nothing', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'kns-cli-'));
  const corpus = await mkdtemp(path.join(tmpdir(), 'kns-corpus-'));
  const fs = await import('node:fs/promises');
  const body = 'y'.repeat(250);

  await fs.writeFile(path.join(corpus, 'shared.md'), `---\nshare: team\nkind: concept\n---\n\n${body}\n`, 'utf8');
  await fs.writeFile(path.join(corpus, 'scratch.md'), `---\nkind: inbox\n---\n\n${body}\n`, 'utf8');

  const added = await cli(
    ['zone', 'add', '--name', 'user', '--namespace', 'user', '--tier', 'USER', '--distance', '0', '--root', corpus],
    home,
  );
  assert.equal(added.code, 0, added.err);

  const before = (await fs.readdir(corpus)).sort();
  const result = await cli(['promote', 'suggest', '--json'], home);
  assert.equal(result.code, 0, result.err);

  const payload = JSON.parse(result.out) as {
    result: { suggestions: { documentId: string; requestedScope: string | null }[] };
  };
  assert.equal(payload.result.suggestions[0]?.documentId, 'shared.md');
  assert.equal(payload.result.suggestions[0]?.requestedScope, 'team');
  assert.deepEqual((await fs.readdir(corpus)).sort(), before, 'suggest must not write');
});

test('promote suggest reports an empty corpus helpfully', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'kns-cli-'));
  const corpus = await mkdtemp(path.join(tmpdir(), 'kns-corpus-'));

  await cli(
    ['zone', 'add', '--name', 'user', '--namespace', 'user', '--tier', 'USER', '--distance', '0', '--root', corpus],
    home,
  );

  const result = await cli(['promote', 'suggest'], home);
  assert.equal(result.code, 0);
  assert.match(result.out, /no promotion candidates/);
});

test('an unknown promote subcommand is rejected', async () => {
  const result = await cli(['promote', 'yeet']);
  assert.equal(result.code, 1);
  assert.match(result.err, /unknown subcommand "promote yeet"/);
});

/** A home with a private corpus and a shared target zone. */
async function homeWithZones(): Promise<{ home: string; corpus: string; target: string }> {
  const home = await mkdtemp(path.join(tmpdir(), 'kns-cli-'));
  const corpus = await mkdtemp(path.join(tmpdir(), 'kns-corpus-'));
  const target = await mkdtemp(path.join(tmpdir(), 'kns-zone-'));

  await cli(
    ['zone', 'add', '--name', 'user', '--namespace', 'user', '--tier', 'USER', '--distance', '0', '--root', corpus],
    home,
  );
  await cli(
    [
      'zone', 'add', '--name', 'team', '--namespace', 'company/platform', '--tier', 'TEAM',
      '--distance', '1', '--root', target,
    ],
    home,
  );
  return { home, corpus, target };
}

test('promote draft writes a provenance-carrying copy into the target zone', async () => {
  const { home, corpus, target } = await homeWithZones();
  const fs = await import('node:fs/promises');
  const body = 'A durable explanation of the reload procedure. '.repeat(6);
  await fs.writeFile(path.join(corpus, 'note.md'), `---\nkind: concept\nowner: me@example.com\n---\n\n${body}\n`, 'utf8');

  const result = await cli(['promote', 'draft', 'note.md', '--to', 'team', '--as', 'me'], home);
  assert.equal(result.code, 0, result.err);

  const written = await fs.readFile(path.join(target, 'note.md'), 'utf8');
  assert.match(written, /promoted_from: note\.md/);
  assert.match(written, /origin_owner: me@example\.com/);
  assert.match(written, /review_by: /);
});

test('promote draft refuses a document with a secret and writes nothing', async () => {
  const { home, corpus, target } = await homeWithZones();
  const fs = await import('node:fs/promises');
  const body = 'Notes about the deploy. '.repeat(12);
  await fs.writeFile(path.join(corpus, 'leaky.md'), `${body}\npassword = hunter2hunter2hunter2\n`, 'utf8');

  const result = await cli(['promote', 'draft', 'leaky.md', '--to', 'team'], home);

  assert.equal(result.code, 2, 'a refusal is exit code 2, not a generic failure');
  assert.match(result.err, /promotion refused/);
  assert.deepEqual(await fs.readdir(target), []);
});

test('promote draft --dry-run writes nothing but shows the result', async () => {
  const { home, corpus, target } = await homeWithZones();
  const fs = await import('node:fs/promises');
  const body = 'A durable explanation of the reload procedure. '.repeat(6);
  await fs.writeFile(path.join(corpus, 'note.md'), body, 'utf8');

  const result = await cli(['promote', 'draft', 'note.md', '--to', 'team', '--dry-run', '--json'], home);
  assert.equal(result.code, 0, result.err);

  const payload = JSON.parse(result.out) as { result: { written: boolean; contents: string } };
  assert.equal(payload.result.written, false);
  assert.match(payload.result.contents, /promoted_from: note\.md/);
  assert.deepEqual(await fs.readdir(target), []);
});

test('promote draft rejects the private tier as a target', async () => {
  const { home, corpus } = await homeWithZones();
  const fs = await import('node:fs/promises');
  await fs.writeFile(path.join(corpus, 'note.md'), 'body '.repeat(60), 'utf8');

  const result = await cli(['promote', 'draft', 'note.md', '--to', 'user'], home);
  assert.equal(result.code, 1);
  assert.match(result.err, /is the private tier/);
});

test('promote draft requires a document and a target', async () => {
  const { home } = await homeWithZones();

  assert.match((await cli(['promote', 'draft'], home)).err, /document id is required/);
  assert.match((await cli(['promote', 'draft', 'note.md'], home)).err, /--to <zone> is required/);
  assert.match((await cli(['promote', 'draft', 'note.md', '--to', 'ghost'], home)).err, /no zone named/);
});

test('promote draft refuses a document id that escapes the corpus', async () => {
  const { home } = await homeWithZones();
  const result = await cli(['promote', 'draft', '../../etc/passwd', '--to', 'team'], home);

  assert.equal(result.code, 1);
  assert.match(result.err, /escapes the zone root/);
});

test('publish and revoke refuse to run without --confirm', async () => {
  const { home, corpus } = await homeWithZones();
  const fs = await import('node:fs/promises');
  await fs.writeFile(path.join(corpus, 'note.md'), 'body '.repeat(60), 'utf8');

  const publishAttempt = await cli(['promote', 'publish', 'note.md', '--to', 'team'], home);
  assert.equal(publishAttempt.code, 1);
  assert.match(publishAttempt.err, /--confirm is required to publish note\.md/);

  const revokeAttempt = await cli(['promote', 'revoke', 'note.md', '--to', 'team'], home);
  assert.equal(revokeAttempt.code, 1);
  assert.match(revokeAttempt.err, /--confirm is required to revoke note\.md/);
});

test('publish requires a document and a target zone', async () => {
  const { home } = await homeWithZones();

  assert.match((await cli(['promote', 'publish'], home)).err, /document id is required/);
  assert.match((await cli(['promote', 'publish', 'note.md'], home)).err, /--to <zone> is required/);
});

test('demand signals are off until explicitly enabled', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'kns-cli-'));

  const status = await cli(['signal', 'status', '--json'], home);
  assert.equal(status.code, 0);
  assert.equal((JSON.parse(status.out) as { result: { enabled: boolean } }).result.enabled, false);
});

test('exporting requires both the opt-in and an explicit confirmation', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'kns-cli-'));

  const noConfirm = await cli(['signal', 'export'], home);
  assert.equal(noConfirm.code, 1);
  assert.match(noConfirm.err, /--confirm is required/);

  const disabled = await cli(['signal', 'export', '--confirm'], home);
  assert.equal(disabled.code, 1);
  assert.match(disabled.err, /demand signals are disabled/);
});

test('enabling, counting, exporting, and purging round-trips', async () => {
  const home = await homeWithFakeZone();

  assert.equal((await cli(['signal', 'enable'], home)).code, 0);
  assert.equal((await cli(['resolve', 'index reload'], home)).code, 0);

  const stats = await cli(['signal', 'stats', '--json'], home);
  const rows = (JSON.parse(stats.out) as { result: { rows: { documentId: string }[] } }).result.rows;
  assert.ok(rows.length > 0, 'a retrieval was counted');

  const exported = await cli(['signal', 'export', '--confirm'], home);
  assert.equal(exported.code, 0, exported.err);
  const payload = JSON.parse(exported.out) as {
    result: { reports: { bucket: string; reporter: string; documentId: string }[] };
  };
  assert.ok(payload.result.reports.length > 0);
  assert.match(payload.result.reports[0]?.bucket ?? '', /^(1-2|3-5|6-10|10\+)$/);
  assert.ok(!exported.out.includes('index reload'), 'the query must never appear in an export');

  const purged = await cli(['signal', 'purge', '--json'], home);
  assert.equal(purged.code, 0);
  assert.equal((await cli(['signal', 'stats', '--json'], home)).out.includes('"rows": []'), true);
});

test('disabling stops the counting', async () => {
  const home = await homeWithFakeZone();

  await cli(['signal', 'enable'], home);
  await cli(['signal', 'disable'], home);
  await cli(['resolve', 'index reload'], home);

  const stats = await cli(['signal', 'stats', '--json'], home);
  assert.match(stats.out, /"rows": \[\]/);
});

test('an unknown signal subcommand is rejected', async () => {
  const result = await cli(['signal', 'broadcast']);
  assert.equal(result.code, 1);
  assert.match(result.err, /unknown subcommand "signal broadcast"/);
});

test('review lists what needs attention and changes nothing', async () => {
  const { home, target } = await homeWithZones();
  const fs = await import('node:fs/promises');
  const body = 'A durable explanation of the reload procedure. '.repeat(6);

  await fs.writeFile(path.join(target, 'stale.md'), `---\nreview_by: 2020-01-01\norigin_owner: team\n---\n\n${body}\n`, 'utf8');
  await fs.writeFile(path.join(target, 'fine.md'), `---\nreview_by: 2099-01-01\norigin_owner: team\n---\n\n${body}\n`, 'utf8');

  const before = await fs.readFile(path.join(target, 'stale.md'), 'utf8');
  const result = await cli(['review', '--zone', 'team', '--json'], home);
  assert.equal(result.code, 0, result.err);

  const payload = JSON.parse(result.out) as { result: { items: { documentId: string }[] } };
  assert.deepEqual(payload.result.items.map((item) => item.documentId), ['stale.md']);
  assert.equal(await fs.readFile(path.join(target, 'stale.md'), 'utf8'), before, 'listing must not write');
});

test('review requires a zone, and changes require confirmation', async () => {
  const { home } = await homeWithZones();

  assert.match((await cli(['review'], home)).err, /--zone <name> is required/);
  assert.match(
    (await cli(['review', '--zone', 'team', '--demote', 'a.md'], home)).err,
    /--confirm is required to change a shared zone/,
  );
});

test('review reports a clean zone', async () => {
  const { home } = await homeWithZones();
  const result = await cli(['review', '--zone', 'team'], home);

  assert.equal(result.code, 0);
  assert.match(result.out, /nothing needs review/);
});
