/**
 * Integration coverage against the real ZBrain MCP server.
 *
 * The fake server in `fixtures/fake-zone` proves the client survives misbehaviour;
 * this suite proves it speaks to the engine KNS actually ships against. It skips
 * rather than fails when ZBrain is not installed, so the repository stays clonable
 * and testable without it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { StdioZoneClient } from '../src/zone/client.ts';
import type { Zone } from '../src/core/types.ts';

/** Locate an executable on PATH. */
function which(command: string): string | null {
  const result = spawnSync('/usr/bin/env', ['sh', '-c', `command -v ${command}`], {
    encoding: 'utf8',
  });
  const found = result.stdout.trim();
  return result.status === 0 && found !== '' ? found : null;
}

/** Build a small indexed corpus and return its root, or null when indexing fails. */
async function buildCorpus(): Promise<string | null> {
  const root = await mkdtemp(path.join(tmpdir(), 'kns-zbrain-'));

  await writeFile(
    path.join(root, 'hot-index-reload.md'),
    [
      '# Hot index reload',
      '',
      'Swap a freshly built index in without dropping the one currently served.',
      'The reload is atomic: readers keep the old generation until the new one is ready.',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    path.join(root, 'unrelated.md'),
    '# Sourdough\n\nFeed the starter twice a day at room temperature.\n',
    'utf8',
  );

  const imported = spawnSync('zbrain', ['import', root, '--json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return imported.status === 0 ? root : null;
}

/** A registry entry pointing at a real ZBrain zone. */
function zbrainZone(root: string): Zone {
  return {
    name: 'zbrain-integration',
    namespace: 'user',
    tier: 'USER',
    distance: 0,
    transport: { kind: 'stdio', command: 'zbrain-mcp', args: ['--root', root] },
    ttlSeconds: 0,
    halfLifeDays: 365,
    owner: null,
    sourceRepo: null,
    neverEarlyExit: false,
    delegatesTo: [],
  };
}

test('the client retrieves from a real zbrain-mcp zone', async (t) => {
  if (which('zbrain') === null || which('zbrain-mcp') === null) {
    t.skip('zbrain and zbrain-mcp are not on PATH');
    return;
  }

  const root = await buildCorpus();
  if (root === null) {
    t.skip('zbrain import failed in this environment');
    return;
  }

  const client = new StdioZoneClient(zbrainZone(root));
  t.after(() => client.close());

  const hits = await client.search('index reload', 5, 20_000);
  assert.ok(hits.length > 0, 'expected at least one hit from the real engine');
  assert.ok(
    hits.some((hit) => hit.documentId.includes('hot-index-reload')),
    `expected the reload note among ${JSON.stringify(hits.map((hit) => hit.documentId))}`,
  );

  const status = await client.status(20_000);
  assert.ok(status.documents === null || status.documents >= 2);
});
