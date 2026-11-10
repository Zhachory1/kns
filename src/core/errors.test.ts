import test from 'node:test';
import assert from 'node:assert/strict';

import { SCHEMA_VERSION } from '../version.ts';
import { ERROR_CODES, KnsError, isErrorCode, isRetryable, ok, toErrorEnvelope } from './errors.ts';

test('ERROR_CODES is duplicate-free and recognised by isErrorCode', () => {
  assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length);
  for (const code of ERROR_CODES) {
    assert.ok(isErrorCode(code));
  }
  assert.equal(isErrorCode('nope'), false);
  assert.equal(isErrorCode(7), false);
});

test('only transient zone failures are retryable', () => {
  assert.equal(isRetryable('zone_timeout'), true);
  assert.equal(isRetryable('zone_unavailable'), true);
  assert.equal(isRetryable('invalid_request'), false);
  assert.equal(isRetryable('sanitizer_blocked'), false);
  assert.equal(isRetryable('registry_invalid'), false);
  assert.equal(isRetryable('internal'), false);
});

test('KnsError carries its code, next step, and retryability', () => {
  const error = new KnsError('zone_timeout', 'zone took too long', 'raise zoneDeadlineMs');

  assert.ok(error instanceof Error);
  assert.equal(error.name, 'KnsError');
  assert.equal(error.code, 'zone_timeout');
  assert.equal(error.nextStep, 'raise zoneDeadlineMs');
  assert.equal(error.retryable, true);
  assert.equal(error.message, 'zone took too long');
});

test('KnsError defaults nextStep to null', () => {
  assert.equal(new KnsError('internal', 'boom').nextStep, null);
});

test('ok wraps a payload in a versioned envelope', () => {
  assert.deepEqual(ok({ hits: [] }), {
    schemaVersion: SCHEMA_VERSION,
    ok: true,
    result: { hits: [] },
  });
});

test('toErrorEnvelope preserves KnsError detail', () => {
  const envelope = toErrorEnvelope(
    new KnsError('sanitizer_blocked', 'secret detected', 'remove the secret'),
  );

  assert.deepEqual(envelope, {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    error: {
      code: 'sanitizer_blocked',
      message: 'secret detected',
      retryable: false,
      nextStep: 'remove the secret',
    },
  });
});

test('toErrorEnvelope maps unknown throwables to internal', () => {
  const fromError = toErrorEnvelope(new TypeError('bad type'));
  assert.equal(fromError.error.code, 'internal');
  assert.equal(fromError.error.message, 'bad type');
  assert.equal(fromError.error.retryable, false);
  assert.equal(fromError.error.nextStep, null);

  const fromString = toErrorEnvelope('just a string');
  assert.equal(fromString.error.code, 'internal');
  assert.equal(fromString.error.message, 'just a string');
});
