import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { KnsError } from '../core/errors.ts';
import type { Zone } from '../core/types.ts';
import { DEFAULT_REVIEW_DAYS, buildDraft, readSource, safeTargetPath, writeDraft } from './draft.ts';
import { parseDocument } from './frontmatter.ts';

const NOW = new Date('2026-08-10T12:00:00.000Z');
const BODY = 'A durable explanation of how the index reload works. '.repeat(6);

/** The target zone. */
function zone(): Zone {
  return {
    name: 'team-platform',
    namespace: 'company/platform',
    tier: 'TEAM',
    distance: 1,
    transport: { kind: 'stdio', command: 'zbrain-mcp', args: [] },
    ttlSeconds: 3600,
    halfLifeDays: 180,
    owner: 'platform-team',
    sourceRepo: null,
    neverEarlyExit: false,
  };
}

/** Draft inputs with overridable fields. */
function input(overrides: Partial<Parameters<typeof buildDraft>[0]> = {}) {
  return {
    documentId: 'concepts/hot-index-reload.md',
    sourceText: `---\ntitle: Hot index reload\nkind: concept\nowner: me@example.com\n---\n\n${BODY}\n`,
    targetRoot: '/zones/team',
    zone: zone(),
    promotedBy: 'me',
    now: NOW,
    ...overrides,
  };
}

test('safeTargetPath resolves inside the root', () => {
  assert.equal(safeTargetPath('/zones/team', 'concepts/a.md'), path.resolve('/zones/team/concepts/a.md'));
  assert.equal(safeTargetPath('/zones/team/', './a.md'), path.resolve('/zones/team/a.md'));
});

test('safeTargetPath refuses anything that escapes the zone', () => {
  for (const escape of ['../outside.md', 'a/../../outside.md', '/etc/passwd', 'a/../../../tmp/x.md']) {
    assert.throws(
      () => safeTargetPath('/zones/team', escape),
      (error: unknown) => error instanceof KnsError && error.code === 'invalid_request',
      `escape not refused: ${escape}`,
    );
  }
});

test('safeTargetPath refuses empty and null-byte identifiers', () => {
  assert.throws(() => safeTargetPath('/zones/team', '   '), KnsError);
  assert.throws(() => safeTargetPath('/zones/team', 'a\0b.md'), KnsError);
});

test('a draft carries provenance frontmatter', () => {
  const plan = buildDraft(input());
  const parsed = parseDocument(plan.contents);

  assert.equal(parsed.fields['promoted_from'], 'concepts/hot-index-reload.md');
  assert.equal(parsed.fields['promoted_by'], 'me');
  assert.equal(parsed.fields['promoted_at'], '2026-08-10');
  assert.equal(parsed.fields['origin_owner'], 'me@example.com');
  assert.equal(parsed.fields['canonical'], 'true');
  assert.equal(parsed.fields['title'], 'Hot index reload');
  assert.equal(parsed.fields['kind'], 'concept');
});

test('the review date defaults to the documented window', () => {
  const parsed = parseDocument(buildDraft(input()).contents);
  const expected = new Date(NOW.getTime());
  expected.setUTCDate(expected.getUTCDate() + DEFAULT_REVIEW_DAYS);

  assert.equal(parsed.fields['review_by'], expected.toISOString().slice(0, 10));
});

test('the review window is configurable', () => {
  const parsed = parseDocument(buildDraft(input({ reviewDays: 30 })).contents);
  assert.equal(parsed.fields['review_by'], '2026-09-09');
});

test('origin_owner falls back to the promoter when the source names none', () => {
  const parsed = parseDocument(
    buildDraft(input({ sourceText: `---\nkind: concept\n---\n\n${BODY}\n` })).contents,
  );
  assert.equal(parsed.fields['origin_owner'], 'me');
});

test('a document with no frontmatter still gets provenance', () => {
  const parsed = parseDocument(buildDraft(input({ sourceText: BODY })).contents);

  assert.equal(parsed.fields['promoted_by'], 'me');
  assert.match(parsed.body, /index reload/);
});

test('a blocked source refuses to produce a draft', () => {
  assert.throws(
    () => buildDraft(input({ sourceText: `${BODY}\npassword = hunter2hunter2hunter2\n` })),
    (error: unknown) =>
      error instanceof KnsError &&
      error.code === 'sanitizer_blocked' &&
      /remove the secret from the source note/.test(error.nextStep ?? ''),
  );
});

test('personal data is redacted into the draft rather than blocking it', () => {
  const plan = buildDraft(input({ sourceText: `${BODY}\nAsk alex@example.com about it.\n` }));

  assert.match(plan.contents, /\[redacted:email\]/);
  assert.ok(!plan.contents.includes('alex@example.com'));
  assert.equal(plan.sanitizer.blocked, false);
});

test('a draft never escapes the target zone', () => {
  assert.throws(
    () => buildDraft(input({ documentId: '../../escape.md' })),
    (error: unknown) => error instanceof KnsError && /escapes the zone root/.test(error.message),
  );
});

test('writeDraft creates directories and leaves the origin untouched', async () => {
  const corpus = await mkdtemp(path.join(tmpdir(), 'kns-origin-'));
  const target = await mkdtemp(path.join(tmpdir(), 'kns-zone-'));
  const sourceFile = path.join(corpus, 'note.md');
  const sourceText = `---\nkind: concept\n---\n\n${BODY}\n`;
  await writeFile(sourceFile, sourceText, 'utf8');

  const plan = buildDraft(
    input({ documentId: 'concepts/nested/note.md', sourceText, targetRoot: target }),
  );
  await writeDraft(plan);

  const written = await readFile(path.join(target, 'concepts', 'nested', 'note.md'), 'utf8');
  assert.match(written, /promoted_from: concepts\/nested\/note\.md/);
  assert.equal(await readFile(sourceFile, 'utf8'), sourceText, 'the origin must not be modified');
});

test('a blocked draft writes nothing at all', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'kns-zone-'));

  assert.throws(() =>
    buildDraft(input({ sourceText: `${BODY}\napi_key = zQ8vN2xK7pL4mR9tW3yB6cF1hJ5sD0gA\n`, targetRoot: target })),
  );
  assert.deepEqual(await readdir(target), [], 'the target zone must be untouched');
});

test('readSource reads a document and refuses an escape', async () => {
  const corpus = await mkdtemp(path.join(tmpdir(), 'kns-origin-'));
  await writeFile(path.join(corpus, 'note.md'), 'body', 'utf8');

  assert.equal(await readSource(corpus, 'note.md'), 'body');
  await assert.rejects(() => readSource(corpus, '../escape.md'), KnsError);
  await assert.rejects(
    () => readSource(corpus, 'missing.md'),
    (error: unknown) => error instanceof KnsError && /no document "missing.md"/.test(error.message),
  );
});

test('drafting the same document twice is idempotent', () => {
  const first = buildDraft(input());
  const second = buildDraft(input());

  assert.equal(first.contents, second.contents);
});
