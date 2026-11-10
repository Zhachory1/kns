import test from 'node:test';
import assert from 'node:assert/strict';

import { flagBoolean, flagNumber, flagString, parseArgs, unknownFlags } from './args.ts';

test('parseArgs separates positionals from flags', () => {
  const args = parseArgs(['zone', 'show', 'team', '--json']);

  assert.deepEqual(args.positional, ['zone', 'show', 'team']);
  assert.equal(args.flags.get('json'), true);
});

test('parseArgs accepts both --name value and --name=value', () => {
  const args = parseArgs(['--name', 'team', '--namespace=company/platform']);

  assert.equal(args.flags.get('name'), 'team');
  assert.equal(args.flags.get('namespace'), 'company/platform');
});

test('parseArgs treats a flag followed by another flag as a switch', () => {
  const args = parseArgs(['--json', '--scope', 'company']);

  assert.equal(args.flags.get('json'), true);
  assert.equal(args.flags.get('scope'), 'company');
});

test('parseArgs treats everything after -- as positional', () => {
  const args = parseArgs(['resolve', '--', '--not-a-flag', 'text']);

  assert.deepEqual(args.positional, ['resolve', '--not-a-flag', 'text']);
  assert.equal(args.flags.size, 0);
});

test('parseArgs handles an empty argument vector', () => {
  const args = parseArgs([]);
  assert.deepEqual(args.positional, []);
  assert.equal(args.flags.size, 0);
});

test('flagString returns null for switches and missing flags', () => {
  const args = parseArgs(['--json', '--name', 'team']);

  assert.equal(flagString(args, 'name'), 'team');
  assert.equal(flagString(args, 'json'), null);
  assert.equal(flagString(args, 'absent'), null);
});

test('flagNumber parses numbers and reports unparseable values as NaN', () => {
  const args = parseArgs(['--distance', '2', '--ttl', 'soon']);

  assert.equal(flagNumber(args, 'distance'), 2);
  assert.ok(Number.isNaN(flagNumber(args, 'ttl') ?? 0));
  assert.equal(flagNumber(args, 'absent'), null);
});

test('flagBoolean accepts a switch or an explicit true', () => {
  const args = parseArgs(['--json', '--verbose=true', '--quiet=false']);

  assert.equal(flagBoolean(args, 'json'), true);
  assert.equal(flagBoolean(args, 'verbose'), true);
  assert.equal(flagBoolean(args, 'quiet'), false);
  assert.equal(flagBoolean(args, 'absent'), false);
});

test('unknownFlags reports what a command does not accept', () => {
  const args = parseArgs(['--json', '--scoop', 'x', '--nmae', 'y']);

  assert.deepEqual(unknownFlags(args, ['json', 'scope']), ['nmae', 'scoop']);
  assert.deepEqual(unknownFlags(parseArgs(['--json']), ['json']), []);
});
