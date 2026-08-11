import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { extractLinks, parseDocument, renderDocument } from './frontmatter.ts';
import { readCorpus, scoreCandidate, suggest } from './suggest.ts';
import type { LocalDocument } from './suggest.ts';

const NOW = new Date('2026-08-10T12:00:00.000Z');

/** Body long enough to clear the too-short block. */
const BODY = 'x'.repeat(250);

/** A local document with overridable fields. */
function document(overrides: Partial<LocalDocument> = {}): LocalDocument {
  return {
    id: 'concepts/a.md',
    file: '/corpus/concepts/a.md',
    fields: {},
    body: BODY,
    inboundLinks: 0,
    ...overrides,
  };
}

test('parseDocument reads scalars, quotes, and inline lists', () => {
  const parsed = parseDocument(
    ['---', 'title: "Hot index reload"', "kind: 'concept'", 'tags: [rag, retrieval]', 'share: team', '---', '', 'Body text.', ''].join('\n'),
  );

  assert.equal(parsed.hasFrontmatter, true);
  assert.equal(parsed.fields['title'], 'Hot index reload');
  assert.equal(parsed.fields['kind'], 'concept');
  assert.equal(parsed.fields['share'], 'team');
  assert.deepEqual(parsed.lists['tags'], ['rag', 'retrieval']);
  assert.equal(parsed.body.trim(), 'Body text.');
});

test('parseDocument handles a document with no frontmatter', () => {
  const parsed = parseDocument('# Title\n\nBody.\n');

  assert.equal(parsed.hasFrontmatter, false);
  assert.deepEqual(parsed.fields, {});
  assert.match(parsed.body, /# Title/);
});

test('parseDocument ignores an unterminated block rather than guessing', () => {
  const parsed = parseDocument('---\nshare: company\n\nno closing delimiter\n');

  assert.equal(parsed.hasFrontmatter, false);
  assert.equal(parsed.fields['share'], undefined, 'a misread share: is the difference between private and published');
});

test('parseDocument skips comments and malformed lines', () => {
  const parsed = parseDocument(['---', '# a comment', 'not a field', 'kind: concept', '---', 'body'].join('\n'));

  assert.deepEqual(Object.keys(parsed.fields), ['kind']);
});

test('parseDocument normalises CRLF line endings', () => {
  const parsed = parseDocument('---\r\nkind: concept\r\n---\r\n\r\nBody.\r\n');
  assert.equal(parsed.fields['kind'], 'concept');
});

test('renderDocument round-trips through parseDocument', () => {
  const rendered = renderDocument({ kind: 'concept', share: 'team' }, 'Body text.');
  const parsed = parseDocument(rendered);

  assert.equal(parsed.fields['kind'], 'concept');
  assert.equal(parsed.fields['share'], 'team');
  assert.equal(parsed.body.trim(), 'Body text.');
});

test('extractLinks reads wiki links and relative Markdown links', () => {
  const links = extractLinks('See [[hot-index-reload]] and [notes](../notes/a.md) and [ext](https://example.com).');

  assert.deepEqual(links, ['hot-index-reload', '../notes/a.md']);
});

test('extractLinks deduplicates', () => {
  assert.deepEqual(extractLinks('[[a]] [[a]] [x](b.md) [y](b.md)'), ['a', 'b.md']);
});

test('an explicit share tag dominates the ranking', () => {
  const tagged = scoreCandidate(document({ fields: { share: 'team' } }), NOW);
  const kindOnly = scoreCandidate(document({ fields: { kind: 'concept' } }), NOW);

  assert.ok(tagged.score > kindOnly.score);
  assert.equal(tagged.requestedScope, 'team');
  assert.match(tagged.reasons.join(' '), /author tagged share: team/);
});

test('knowledge kinds score above working material', () => {
  const concept = scoreCandidate(document({ fields: { kind: 'concept' } }), NOW);
  const inbox = scoreCandidate(document({ fields: { kind: 'inbox' } }), NOW);

  assert.ok(concept.score > inbox.score);
  assert.match(inbox.reasons.join(' '), /working material/);
});

test('the type field is accepted as an alias for kind', () => {
  const byType = scoreCandidate(document({ fields: { type: 'decision' } }), NOW);
  assert.match(byType.reasons.join(' '), /kind is decision/);
});

test('inbound links and demand both raise the score, with a ceiling', () => {
  const linked = scoreCandidate(document({ inboundLinks: 3 }), NOW);
  const heavilyLinked = scoreCandidate(document({ inboundLinks: 50 }), NOW);
  const demanded = scoreCandidate(document({}), NOW, 4);

  assert.ok(linked.score > 0);
  assert.equal(heavilyLinked.score, 20, 'the link bonus is capped');
  assert.match(demanded.reasons.join(' '), /retrieved 4 time\(s\)/);
});

test('a document past its own review date is blocked', () => {
  const stale = scoreCandidate(
    document({ fields: { share: 'team', review_by: '2026-01-01' } }),
    NOW,
  );

  assert.equal(stale.blocked, true);
  assert.match(stale.reasons.join(' '), /past its own review_by/);
});

test('a future or unparseable review date does not block', () => {
  assert.equal(scoreCandidate(document({ fields: { share: 'team', review_by: '2027-01-01' } }), NOW).blocked, false);
  assert.equal(scoreCandidate(document({ fields: { share: 'team', review_by: 'someday' } }), NOW).blocked, false);
});

test('a document too short to help anyone is blocked', () => {
  const stub = scoreCandidate(document({ fields: { share: 'team' }, body: 'too short' }), NOW);

  assert.equal(stub.blocked, true);
  assert.match(stub.reasons.join(' '), /too short/);
});

test('suggest ranks unblocked candidates first and is deterministic', () => {
  const documents = [
    document({ id: 'b.md', fields: { kind: 'concept' } }),
    document({ id: 'a.md', fields: { share: 'company' } }),
    document({ id: 'c.md', fields: { share: 'team' }, body: 'short' }),
    document({ id: 'd.md', fields: { kind: 'journal' } }),
  ];

  const ranked = suggest(documents, NOW);

  assert.deepEqual(
    ranked.map((entry) => entry.documentId),
    ['a.md', 'b.md', 'c.md'],
  );
  assert.equal(ranked[2]?.blocked, true);
  assert.deepEqual(suggest([...documents].reverse(), NOW).map((entry) => entry.documentId), [
    'a.md',
    'b.md',
    'c.md',
  ]);
});

test('readCorpus walks a directory and counts inbound links', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kns-corpus-'));
  await mkdir(path.join(root, 'concepts'), { recursive: true });
  await mkdir(path.join(root, '.git'), { recursive: true });

  await writeFile(
    path.join(root, 'concepts', 'hot-index-reload.md'),
    `---\nkind: concept\n---\n\n${BODY}\n`,
    'utf8',
  );
  await writeFile(path.join(root, 'a.md'), `See [[hot-index-reload]].\n${BODY}`, 'utf8');
  await writeFile(path.join(root, 'b.md'), `Also [[hot-index-reload]] and [[hot-index-reload]].\n${BODY}`, 'utf8');
  await writeFile(path.join(root, 'self.md'), `I link to [[self]].\n${BODY}`, 'utf8');
  await writeFile(path.join(root, '.git', 'ignored.md'), 'should not be read', 'utf8');
  await writeFile(path.join(root, 'notes.txt'), 'not markdown', 'utf8');

  const documents = await readCorpus(root);

  assert.deepEqual(
    documents.map((entry) => entry.id).sort(),
    ['a.md', 'b.md', path.join('concepts', 'hot-index-reload.md'), 'self.md'],
  );

  const target = documents.find((entry) => entry.id.endsWith('hot-index-reload.md'));
  assert.equal(target?.inboundLinks, 2, 'duplicate links from one document count once');

  const self = documents.find((entry) => entry.id === 'self.md');
  assert.equal(self?.inboundLinks, 0, 'a self-link is not evidence anyone else needs it');
});

test('readCorpus returns nothing for a missing directory', async () => {
  assert.deepEqual(await readCorpus('/definitely/not/here'), []);
});

test('readCorpus never writes to the corpus', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kns-corpus-'));
  await writeFile(path.join(root, 'a.md'), BODY, 'utf8');

  const before = await readdir(root);
  await readCorpus(root);
  assert.deepEqual(await readdir(root), before);
});
