/**
 * End-to-end coverage of the `kns` executable.
 *
 * The unit tests drive `run()` in-process; this suite spawns the real binary so that
 * the shebang, the argument slice, and the exit-code binding are exercised too.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const binary = path.join(root, 'bin', 'kns.js');

/** Invoke the binary with an isolated KNS home. */
function kns(argv: string[], home: string): { code: number; stdout: string; stderr: string } {
  const env = { ...process.env, KNS_HOME: home };
  delete env['NODE_TEST_CONTEXT'];

  const result = spawnSync(process.execPath, [binary, ...argv], { cwd: root, encoding: 'utf8', env });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

test('the binary reports its version and exits zero', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'kns-e2e-'));
  const result = kns(['--version'], home);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /^kns \d+\.\d+\.\d+ \(schema \d+\)$/m);
});

test('the binary adds and lists a zone against KNS_HOME', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'kns-e2e-'));

  const added = kns(
    ['zone', 'add', '--name', 'user', '--namespace', 'user', '--tier', 'USER', '--distance', '0', '--root', '/docs'],
    home,
  );
  assert.equal(added.code, 0, added.stderr);

  const listed = kns(['zone', 'list', '--json'], home);
  assert.equal(listed.code, 0);
  const payload = JSON.parse(listed.stdout) as { result: { zones: { name: string }[] } };
  assert.deepEqual(
    payload.result.zones.map((zone) => zone.name),
    ['user'],
  );
});

test('the binary exits non-zero and writes the error to stderr', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'kns-e2e-'));
  const result = kns(['zone', 'show', 'ghost'], home);

  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /no zone named "ghost"/);
});
