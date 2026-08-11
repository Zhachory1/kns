import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SCHEMA_VERSION, VERSION, describeVersion } from './version.ts';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

test('VERSION matches package.json', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
    version: string;
  };
  assert.equal(VERSION, manifest.version);
});

test('SCHEMA_VERSION is a positive integer', () => {
  assert.ok(Number.isInteger(SCHEMA_VERSION));
  assert.ok(SCHEMA_VERSION > 0);
});

test('describeVersion renders package and schema version', () => {
  assert.equal(describeVersion(), `kns ${VERSION} (schema ${SCHEMA_VERSION})`);
});
