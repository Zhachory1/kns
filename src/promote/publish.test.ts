import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { KnsError } from '../core/errors.ts';
import {
  PROTECTED_BRANCHES,
  assertPublishableBranch,
  branchNameFor,
  clearOriginPointer,
  publish,
  qualifiedPath,
  realExec,
  writeOriginPointer,
} from './publish.ts';
import type { Exec, ExecResult } from './publish.ts';

const NOW = new Date('2026-08-10T12:00:00.000Z');
const BODY = 'A durable explanation of the reload procedure. '.repeat(6);

/** A recorder that succeeds and remembers what it was asked to run. */
function recordingExec(overrides: Record<string, ExecResult> = {}): {
  exec: Exec;
  calls: string[];
} {
  const calls: string[] = [];
  const exec: Exec = async (command, args) => {
    const line = `${command} ${args.join(' ')}`;
    calls.push(line);
    return overrides[command] ?? { code: 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
}

/** A zone checkout containing a drafted document. */
async function zoneWithDraft(contents = `---\npromoted_by: me\n---\n\n${BODY}\n`): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'kns-publish-'));
  await writeFile(path.join(root, 'note.md'), contents, 'utf8');
  return root;
}

test('protected branches are refused', () => {
  for (const branch of PROTECTED_BRANCHES) {
    assert.throws(
      () => assertPublishableBranch(branch),
      (error: unknown) => error instanceof KnsError && /protected branch/.test(error.message),
    );
  }
  assert.doesNotThrow(() => assertPublishableBranch('kns/promote-note-2026-08-10'));
});

test('branch names are derived, slugged, and dated', () => {
  assert.equal(branchNameFor('concepts/hot index reload.md', NOW), 'kns/promote-concepts-hot-index-reload-2026-08-10');
  assert.equal(branchNameFor('a.md', NOW), 'kns/promote-a-2026-08-10');
  assert.ok(!PROTECTED_BRANCHES.includes(branchNameFor('main.md', NOW)));
});

test('a generated branch name is never protected', () => {
  for (const name of ['main.md', 'master.md', 'HEAD.md', '../../main.md']) {
    assert.doesNotThrow(() => assertPublishableBranch(branchNameFor(name, NOW)));
  }
});

test('publish creates a branch, stages by path, commits, pushes, and opens a PR', async () => {
  const root = await zoneWithDraft();
  const { exec, calls } = recordingExec({
    gh: { code: 0, stdout: 'https://example.com/org/zone/pull/7\n', stderr: '' },
  });

  const result = await publish({
    zoneRoot: root,
    documentId: 'note.md',
    zoneName: 'team',
    promotedBy: 'me',
    now: NOW,
    exec,
  });

  assert.equal(result.branch, 'kns/promote-note-2026-08-10');
  assert.equal(result.url, 'https://example.com/org/zone/pull/7');
  assert.deepEqual(calls, [
    'git checkout -b kns/promote-note-2026-08-10',
    'git add -- note.md',
    'git commit -m docs(kns): promote note.md to team -m Promoted by me via kns promote publish.\n\nProvenance is in the document frontmatter.',
    'git push --set-upstream origin kns/promote-note-2026-08-10',
    'gh pr create --title docs(kns): promote note.md to team --body Promoted by me via kns promote publish.\n\nProvenance is in the document frontmatter. --head kns/promote-note-2026-08-10',
  ]);
});

test('publish stages by path rather than sweeping the checkout', async () => {
  const root = await zoneWithDraft();
  await writeFile(path.join(root, 'unrelated-scratch.md'), 'not part of this promotion', 'utf8');
  const { exec, calls } = recordingExec();

  await publish({ zoneRoot: root, documentId: 'note.md', zoneName: 'team', promotedBy: 'me', now: NOW, exec });

  assert.ok(
    calls.every((call) => !/git add (-A|--all|\.)/.test(call)),
    'git add -A would sweep in whatever else is sitting in the zone checkout',
  );
});

test('publish never force-pushes and never targets a default branch', async () => {
  const root = await zoneWithDraft();
  const { exec, calls } = recordingExec();

  await publish({ zoneRoot: root, documentId: 'note.md', zoneName: 'team', promotedBy: 'me', now: NOW, exec });

  const push = calls.find((call) => call.startsWith('git push')) ?? '';
  assert.ok(!/--force|-f\b/.test(push));
  for (const branch of PROTECTED_BRANCHES) {
    assert.ok(!push.endsWith(` ${branch}`), `push targeted ${branch}`);
  }
});

test('publish re-runs the sanitizer against the bytes being committed', async () => {
  const root = await zoneWithDraft(`---\npromoted_by: me\n---\n\n${BODY}\npassword = hunter2hunter2hunter2\n`);
  const { exec, calls } = recordingExec();

  await assert.rejects(
    () => publish({ zoneRoot: root, documentId: 'note.md', zoneName: 'team', promotedBy: 'me', now: NOW, exec }),
    (error: unknown) =>
      error instanceof KnsError &&
      error.code === 'sanitizer_blocked' &&
      /edited after it was created/.test(error.nextStep ?? ''),
  );
  assert.deepEqual(calls, [], 'nothing ran: the gate is before the first git command');
});

test('a failing git command aborts the publish with its stderr', async () => {
  const root = await zoneWithDraft();
  const exec: Exec = async (command) =>
    command === 'git' ? { code: 1, stdout: '', stderr: 'fatal: not a git repository' } : { code: 0, stdout: '', stderr: '' };

  await assert.rejects(
    () => publish({ zoneRoot: root, documentId: 'note.md', zoneName: 'team', promotedBy: 'me', now: NOW, exec }),
    (error: unknown) => error instanceof KnsError && /not a git repository/.test(error.message),
  );
});

test('a missing gh reports what the operator should do', async () => {
  const root = await zoneWithDraft();
  const exec: Exec = async (command) =>
    command === 'gh' ? { code: 127, stdout: '', stderr: 'gh: command not found' } : { code: 0, stdout: '', stderr: '' };

  await assert.rejects(
    () => publish({ zoneRoot: root, documentId: 'note.md', zoneName: 'team', promotedBy: 'me', now: NOW, exec }),
    (error: unknown) => error instanceof KnsError && /gh is installed and authenticated/.test(error.nextStep ?? ''),
  );
});

test('a revocation removes the file and says so in the commit', async () => {
  const root = await zoneWithDraft();
  const { exec, calls } = recordingExec();

  await publish({
    zoneRoot: root,
    documentId: 'note.md',
    zoneName: 'team',
    promotedBy: 'me',
    now: NOW,
    exec,
    remove: true,
  });

  assert.ok(calls.some((call) => call === 'git rm -- note.md'));
  assert.ok(calls.some((call) => /demote note\.md/.test(call)));
});

test('a revocation skips the sanitizer, since removal cannot leak', async () => {
  const root = await zoneWithDraft(`${BODY}\npassword = hunter2hunter2hunter2\n`);
  const { exec, calls } = recordingExec();

  await publish({
    zoneRoot: root,
    documentId: 'note.md',
    zoneName: 'team',
    promotedBy: 'me',
    now: NOW,
    exec,
    remove: true,
  });

  assert.ok(calls.length > 0, 'removing a leaked document must not be blocked by the leak');
});

test('publish refuses a document id that escapes the zone', async () => {
  const root = await zoneWithDraft();
  const { exec } = recordingExec();

  await assert.rejects(
    () => publish({ zoneRoot: root, documentId: '../escape.md', zoneName: 'team', promotedBy: 'me', now: NOW, exec }),
    (error: unknown) => error instanceof KnsError && /escapes the zone root/.test(error.message),
  );
});

test('the origin pointer is written and cleared without disturbing the body', async () => {
  const corpus = await mkdtemp(path.join(tmpdir(), 'kns-origin-'));
  const file = path.join(corpus, 'note.md');
  await writeFile(file, `---\nkind: concept\n---\n\n${BODY}\n`, 'utf8');

  await writeOriginPointer(corpus, 'note.md', 'company/platform/note.md');
  const written = await readFile(file, 'utf8');
  assert.match(written, /promoted_to: company\/platform\/note\.md/);
  assert.match(written, /kind: concept/);
  assert.match(written, /durable explanation/);

  assert.equal(await clearOriginPointer(corpus, 'note.md'), true);
  const cleared = await readFile(file, 'utf8');
  assert.ok(!cleared.includes('promoted_to'));
  assert.match(cleared, /kind: concept/);

  assert.equal(await clearOriginPointer(corpus, 'note.md'), false, 'clearing twice is a no-op');
});

test('qualifiedPath namespaces a document', () => {
  assert.equal(qualifiedPath('company/platform', 'concepts/a.md'), 'company/platform/concepts/a.md');
});

test('realExec reports the exit status of a real command', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'kns-exec-'));

  const ok = await realExec('git', ['--version'], cwd);
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /git version/);

  const failed = await realExec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  assert.notEqual(failed.code, 0, 'a non-repository must report failure rather than throw');
});
