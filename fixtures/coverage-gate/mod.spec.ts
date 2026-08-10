// Named `.spec.ts` so the project's own test discovery ignores it. It is executed
// only by test/coverage-gate.test.ts, which asserts that the coverage gate is live.

import test from 'node:test';
import assert from 'node:assert/strict';

import { covered } from './mod.ts';

test('covers only part of the fixture module', () => {
  assert.equal(covered(1, 2), 3);
});
