import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseDocument } from './frontmatter.ts';
import { findStale, renewReview } from './review.ts';
import type { LocalDocument } from './suggest.ts';

const NOW = new Date('2026-08-10T12:00:00.000Z');
const BODY = 'A durable explanation of the reload procedure. '.repeat(6);

/** A promoted document with overridable frontmatter. */
function document(id: string, fields: Record<string, string>): LocalDocument {
  return { id, file: `/zone/${id}`, fields, body: BODY, inboundLinks: 0 };
}

test('a document past its review date is flagged with how overdue it is', () => {
  const items = findStale(
    [document('a.md', { review_by: '2026-07-01', origin_owner: 'team' })],
    NOW,
  );

  assert.equal(items.length, 1);
  assert.equal(items[0]?.overdueDays, 40);
  assert.match(items[0]?.reasons.join(' ') ?? '', /40 day\(s\) past its review date/);
});

test('a document with no review date is flagged as unbounded', () => {
  const items = findStale([document('a.md', { origin_owner: 'team' })], NOW);

  assert.match(items[0]?.reasons.join(' ') ?? '', /no review_by date/);
  assert.equal(items[0]?.overdueDays, null);
});

test('an unowned document is flagged', () => {
  const items = findStale([document('a.md', { review_by: '2027-01-01' })], NOW);

  assert.match(items[0]?.reasons.join(' ') ?? '', /nobody is answerable/);
});

test('an unparseable review date is flagged rather than ignored', () => {
  const items = findStale([document('a.md', { review_by: 'soon', origin_owner: 'team' })], NOW);

  assert.match(items[0]?.reasons.join(' ') ?? '', /unparseable review_by/);
});

test('a healthy document is not flagged', () => {
  assert.deepEqual(findStale([document('a.md', { review_by: '2027-01-01', origin_owner: 'team' })], NOW), []);
});

test('the owner field is accepted as a fallback for origin_owner', () => {
  assert.deepEqual(findStale([document('a.md', { review_by: '2027-01-01', owner: 'me' })], NOW), []);
});

test('items are ordered most overdue first, then by id', () => {
  const items = findStale(
    [
      document('b.md', { review_by: '2026-08-01', origin_owner: 'team' }),
      document('a.md', { review_by: '2026-01-01', origin_owner: 'team' }),
      document('c.md', { origin_owner: 'team' }),
      document('d.md', { origin_owner: 'team' }),
    ],
    NOW,
  );

  assert.deepEqual(
    items.map((item) => item.documentId),
    ['a.md', 'b.md', 'c.md', 'd.md'],
  );
});

test('renewing pushes the review date forward without touching the body', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kns-review-'));
  const file = path.join(root, 'a.md');
  await writeFile(file, `---\nreview_by: 2026-01-01\norigin_owner: team\n---\n\n${BODY}\n`, 'utf8');

  const reviewBy = await renewReview(root, 'a.md', NOW, 30);
  assert.equal(reviewBy, '2026-09-09');

  const parsed = parseDocument(await readFile(file, 'utf8'));
  assert.equal(parsed.fields['review_by'], '2026-09-09');
  assert.equal(parsed.fields['origin_owner'], 'team');
  assert.match(parsed.body, /durable explanation/);
});

test('renewing refuses a document id that escapes the zone', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kns-review-'));
  await assert.rejects(() => renewReview(root, '../escape.md', NOW, 30));
});
