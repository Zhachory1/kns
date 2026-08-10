import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  GENERATED_BEGIN,
  GENERATED_END,
  MIN_DOC_BYTES,
  REQUIRED_DOCS,
  checkDocs,
  checkExportDocs,
  checkGeneratedBlocks,
  checkMarkdownLinks,
  checkRequiredDocs,
  formatFindings,
  generatedBlockBody,
  generatedBlockIds,
  headingSlugs,
  listFiles,
  relativeLinks,
  slugify,
  undocumentedExports,
} from './docs-check.ts';

/** Create an empty temporary project root. */
async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'kns-docs-check-'));
}

/** Write a file inside a project root, creating parent directories. */
async function write(root: string, relative: string, content: string): Promise<void> {
  const absolute = path.join(root, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, 'utf8');
}

/** Body long enough to clear the stub threshold. */
const FILLER = `x`.repeat(MIN_DOC_BYTES);

test('slugify lowercases, strips punctuation, and hyphenates separators', () => {
  assert.equal(slugify('Zone registry'), 'zone-registry');
  assert.equal(slugify('  Ranking: RRF & priors!  '), 'ranking-rrf-priors');
  assert.equal(slugify('snake_case name'), 'snake-case-name');
  assert.equal(slugify('Already-Hyphenated'), 'already-hyphenated');
});

test('listFiles returns an empty list for a missing directory', async () => {
  const root = await makeRoot();
  assert.deepEqual(await listFiles(path.join(root, 'nope'), '.md'), []);
});

test('listFiles filters by extension, sorts, and skips ignored directories', async () => {
  const root = await makeRoot();
  await write(root, 'b.md', 'b');
  await write(root, 'a.md', 'a');
  await write(root, 'c.txt', 'c');
  await write(root, 'nested/d.md', 'd');
  await write(root, 'node_modules/pkg/e.md', 'e');

  const found = (await listFiles(root, '.md')).map((file) => path.relative(root, file));
  assert.deepEqual(found, ['a.md', 'b.md', path.join('nested', 'd.md')]);
});

test('listFiles can stay shallow', async () => {
  const root = await makeRoot();
  await write(root, 'a.md', 'a');
  await write(root, 'nested/d.md', 'd');

  const found = (await listFiles(root, '.md', false)).map((file) => path.relative(root, file));
  assert.deepEqual(found, ['a.md']);
});

test('checkRequiredDocs reports missing and stub documents', async () => {
  const root = await makeRoot();
  await write(root, 'GOOD.md', FILLER);
  await write(root, 'STUB.md', 'too short');

  const findings = await checkRequiredDocs({
    root,
    requiredDocs: ['GOOD.md', 'STUB.md', 'MISSING.md'],
  });

  assert.deepEqual(
    findings.map((finding) => finding.file),
    ['STUB.md', 'MISSING.md'],
  );
  assert.match(findings[0]?.message ?? '', /stub/);
  assert.match(findings[1]?.message ?? '', /missing/);
  assert.ok(findings.every((finding) => finding.rule === 'required-doc'));
});

test('REQUIRED_DOCS is a non-empty, duplicate-free list', () => {
  assert.ok(REQUIRED_DOCS.length > 0);
  assert.equal(new Set(REQUIRED_DOCS).size, REQUIRED_DOCS.length);
});

test('headingSlugs collects every heading level', () => {
  const slugs = headingSlugs('# Top\n\ntext\n\n### Deep Heading\nnot a heading\n');
  assert.deepEqual([...slugs].sort(), ['deep-heading', 'top']);
});

test('relativeLinks skips external schemes and fenced code', () => {
  const markdown = [
    '[a](./a.md) and [b](https://example.com/x)',
    '```',
    '[c](./c.md)',
    '```',
    '[d](../d.md#anchor)',
  ].join('\n');

  assert.deepEqual(relativeLinks(markdown), [
    { target: './a.md', line: 1 },
    { target: '../d.md#anchor', line: 5 },
  ]);
});

test('checkMarkdownLinks accepts valid targets, anchors, and directories', async () => {
  const root = await makeRoot();
  await write(root, 'docs/target.md', '# Real Heading\n');
  await write(
    root,
    'README.md',
    [
      '# Home',
      '[file](docs/target.md)',
      '[anchor](docs/target.md#real-heading)',
      '[self](#home)',
      '[dir](docs)',
    ].join('\n'),
  );

  assert.deepEqual(await checkMarkdownLinks({ root }), []);
});

test('checkMarkdownLinks reports missing files and missing anchors', async () => {
  const root = await makeRoot();
  await write(root, 'docs/target.md', '# Real Heading\n');
  await write(
    root,
    'README.md',
    ['# Home', '[gone](docs/gone.md)', '[bad](docs/target.md#nope)'].join('\n'),
  );

  const findings = await checkMarkdownLinks({ root });
  assert.equal(findings.length, 2);
  assert.match(findings[0]?.message ?? '', /link target does not exist/);
  assert.equal(findings[0]?.line, 2);
  assert.match(findings[1]?.message ?? '', /link anchor does not exist/);
  assert.equal(findings[1]?.line, 3);
});

test('undocumentedExports finds exports without a preceding TSDoc block', () => {
  const source = [
    '/** Documented. */',
    'export const documented = 1;',
    '',
    'export const bare = 2;',
    '',
    '/** Documented across a blank line. */',
    '',
    'export function spaced(): void {}',
    '',
    "export * from './other.ts';",
    '  export const indented = 3;',
  ].join('\n');

  assert.deepEqual(undocumentedExports(source), [
    { line: 4, text: 'export const bare = 2;' },
  ]);
});

test('undocumentedExports flags an export on the very first line', () => {
  assert.deepEqual(undocumentedExports('export const first = 1;\n'), [
    { line: 1, text: 'export const first = 1;' },
  ]);
});

test('checkExportDocs scans sources and ignores test files', async () => {
  const root = await makeRoot();
  await write(root, 'src/good.ts', '/** Doc. */\nexport const good = 1;\n');
  await write(root, 'src/bad.ts', 'export const bad = 1;\n');
  await write(root, 'src/bad.test.ts', 'export const alsoBad = 1;\n');

  const findings = await checkExportDocs({ root });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.file, path.join('src', 'bad.ts'));
  assert.equal(findings[0]?.rule, 'export-doc');
});

test('generatedBlockIds and generatedBlockBody read block markers', () => {
  const markdown = [
    'intro',
    `<!-- ${GENERATED_BEGIN}:cli -->`,
    'body line',
    `<!-- ${GENERATED_END}:cli -->`,
  ].join('\n');

  assert.deepEqual(generatedBlockIds(markdown), ['cli']);
  assert.equal(generatedBlockBody(markdown, 'cli'), 'body line');
  assert.equal(generatedBlockBody(markdown, 'absent'), null);
});

test('generatedBlockBody rejects reversed markers and reads empty bodies', () => {
  const reversed = `<!-- ${GENERATED_END}:cli -->\n<!-- ${GENERATED_BEGIN}:cli -->`;
  assert.equal(generatedBlockBody(reversed, 'cli'), null);

  const empty = `<!-- ${GENERATED_BEGIN}:cli -->\n<!-- ${GENERATED_END}:cli -->`;
  assert.equal(generatedBlockBody(empty, 'cli'), '');
});

test('checkGeneratedBlocks passes when the block matches its generator', async () => {
  const root = await makeRoot();
  await write(root, 'scripts/generators/cli.mjs', 'export const generate = () => "body line";\n');
  await write(
    root,
    'docs/contract-cli.md',
    [`<!-- ${GENERATED_BEGIN}:cli -->`, 'body line', `<!-- ${GENERATED_END}:cli -->`].join('\n'),
  );

  assert.deepEqual(await checkGeneratedBlocks({ root }), []);
});

test('checkGeneratedBlocks reports drift, missing generators, and unterminated blocks', async () => {
  const root = await makeRoot();
  await write(root, 'scripts/generators/cli.mjs', 'export const generate = () => "fresh";\n');
  await write(
    root,
    'docs/contract-cli.md',
    [`<!-- ${GENERATED_BEGIN}:cli -->`, 'stale', `<!-- ${GENERATED_END}:cli -->`].join('\n'),
  );
  await write(root, 'docs/contract-mcp.md', `<!-- ${GENERATED_BEGIN}:mcp -->\nbody\n`);
  await write(
    root,
    'docs/configuration.md',
    [`<!-- ${GENERATED_BEGIN}:config -->`, 'body', `<!-- ${GENERATED_END}:config -->`].join('\n'),
  );

  const findings = await checkGeneratedBlocks({ root });
  const messages = findings.map((finding) => finding.message);

  assert.equal(findings.length, 3);
  assert.ok(messages.some((message) => /is not terminated/.test(message)));
  assert.ok(messages.some((message) => /is out of date/.test(message)));
  assert.ok(messages.some((message) => /no generator found/.test(message)));
  assert.ok(findings.every((finding) => finding.rule === 'generated-block'));
});

test('checkGeneratedBlocks awaits asynchronous generators', async () => {
  const root = await makeRoot();
  await write(
    root,
    'scripts/generators/cli.mjs',
    'export const generate = async () => "async body";\n',
  );
  await write(
    root,
    'docs/contract-cli.md',
    [`<!-- ${GENERATED_BEGIN}:cli -->`, 'async body', `<!-- ${GENERATED_END}:cli -->`].join('\n'),
  );

  assert.deepEqual(await checkGeneratedBlocks({ root }), []);
});

test('checkDocs aggregates every rule', async () => {
  const root = await makeRoot();
  await write(root, 'README.md', `# Home\n[gone](missing.md)\n${FILLER}`);
  await write(root, 'src/bad.ts', 'export const bad = 1;\n');

  const findings = await checkDocs({ root, requiredDocs: ['README.md', 'DESIGN.md'] });
  const rules = new Set(findings.map((finding) => finding.rule));

  assert.ok(rules.has('required-doc'));
  assert.ok(rules.has('link'));
  assert.ok(rules.has('export-doc'));
});

test('formatFindings renders a pass line and a failure report', () => {
  assert.equal(formatFindings([]), 'docs:check passed — 0 findings');

  const report = formatFindings([
    { rule: 'required-doc', file: 'docs/zones.md', message: 'required document is missing' },
    { rule: 'link', file: 'README.md', line: 12, message: 'link target does not exist: x.md' },
  ]);

  assert.match(report, /docs\/zones\.md \[required-doc\] required document is missing/);
  assert.match(report, /README\.md:12 \[link\] link target does not exist: x\.md/);
  assert.match(report, /docs:check failed — 2 finding\(s\)/);
});
