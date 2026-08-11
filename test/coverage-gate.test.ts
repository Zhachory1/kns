/**
 * Proves the coverage gate is live rather than decorative.
 *
 * `package.json` enforces an 80% floor. A threshold that is configured but not
 * actually enforced is worse than none, so this test runs the same runner against a
 * deliberately under-tested fixture and asserts the process fails.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixture = path.join(root, 'fixtures', 'coverage-gate', 'mod.spec.ts');

/**
 * Run the fixture suite under a given set of coverage thresholds.
 *
 * @param thresholds - Percentage floors for lines, branches, and functions.
 * @returns The runner's exit status.
 */
function runFixture(thresholds: { lines: number; branches: number; functions: number }): number {
  // The parent runner exports NODE_TEST_CONTEXT so that children report as subtests.
  // Inherited, it also suppresses the child's threshold exit code, which would make
  // this test vacuously pass. Strip it, along with any inherited runner flags.
  const env = { ...process.env };
  delete env['NODE_TEST_CONTEXT'];
  delete env['NODE_OPTIONS'];

  const result = spawnSync(
    process.execPath,
    [
      '--test',
      '--experimental-test-coverage',
      `--test-coverage-lines=${thresholds.lines}`,
      `--test-coverage-branches=${thresholds.branches}`,
      `--test-coverage-functions=${thresholds.functions}`,
      fixture,
    ],
    { cwd: root, encoding: 'utf8', env },
  );
  return result.status ?? -1;
}

test('the fixture suite passes on its own merits', () => {
  assert.equal(runFixture({ lines: 0, branches: 0, functions: 0 }), 0);
});

test('the coverage gate fails an under-tested module', () => {
  assert.equal(runFixture({ lines: 100, branches: 100, functions: 100 }), 1);
});

test('the project floor is set to 80 on all three metrics', async () => {
  const manifest = JSON.parse(
    await (await import('node:fs/promises')).readFile(path.join(root, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };

  const script = manifest.scripts.test ?? '';
  for (const metric of ['lines', 'branches', 'functions']) {
    assert.match(
      script,
      new RegExp(`--test-coverage-${metric}=(8[0-9]|9[0-9]|100)\\b`),
      `test script must enforce a ${metric} floor of at least 80`,
    );
  }
});
