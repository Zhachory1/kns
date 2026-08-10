/**
 * Documentation coverage checker.
 *
 * Implements the gate described in `docs/documentation-policy.md`. The checker is
 * deliberately dependency-free and lives in `src/` (rather than `scripts/`) so that
 * it is type-checked and covered by tests like any other module.
 *
 * Four rules are enforced:
 *
 * 1. `required-doc` — every document in {@link REQUIRED_DOCS} exists and is not a stub.
 * 2. `link` — every relative Markdown link resolves to a file, and any `#anchor`
 *    resolves to a heading in that file.
 * 3. `export-doc` — every top-level `export` in a source file carries a TSDoc comment.
 * 4. `generated-block` — every generated block matches what its generator produces,
 *    so contract documentation cannot drift from the code it describes.
 *
 * @module
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** A single documentation-coverage violation. */
export interface DocsFinding {
  /** Stable rule identifier, used in output and in tests. */
  rule: 'required-doc' | 'link' | 'export-doc' | 'generated-block';
  /** Path of the offending file, relative to the project root. */
  file: string;
  /** 1-based line number, when the rule can attribute one. */
  line?: number;
  /** Human-readable description of what is wrong. */
  message: string;
}

/** Inputs for a documentation-coverage run. */
export interface DocsCheckOptions {
  /** Absolute path to the project root. */
  root: string;
  /** Documents that must exist. Defaults to {@link REQUIRED_DOCS}. */
  requiredDocs?: readonly string[];
  /** Directories scanned for Markdown files. Defaults to `['.', 'docs']`. */
  docDirs?: readonly string[];
  /** Directories scanned for TypeScript exports. Defaults to `['src']`. */
  sourceDirs?: readonly string[];
}

/**
 * Documents that must exist before the 0.1.0 release.
 *
 * Presence is enforced from the first commit so the set fills in as features land
 * rather than being retrofitted at release time.
 */
export const REQUIRED_DOCS: readonly string[] = [
  'README.md',
  'DESIGN.md',
  'ROADMAP.md',
  'CONTRIBUTING.md',
  'docs/plan-prs.md',
  'docs/documentation-policy.md',
  'docs/contract-cli.md',
  'docs/contract-mcp.md',
  'docs/contract-schemas.md',
  'docs/configuration.md',
  'docs/zones.md',
  'docs/ranking.md',
  'docs/caching.md',
  'docs/promotion.md',
  'docs/privacy.md',
  'docs/threat-model.md',
  'docs/operations.md',
  'docs/evals.md',
];

/** Minimum size, in bytes, before a required document counts as more than a stub. */
export const MIN_DOC_BYTES = 200;

/** Directory names never walked when collecting files. */
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.claude']);

/** Opening marker of a generated documentation block. */
export const GENERATED_BEGIN = 'kns:generated:begin';

/** Closing marker of a generated documentation block. */
export const GENERATED_END = 'kns:generated:end';

/**
 * Convert a Markdown heading to its GitHub-style anchor slug.
 *
 * @param heading - Heading text without leading `#` characters.
 * @returns The anchor slug, e.g. `Zone registry` becomes `zone-registry`.
 */
export function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/[ _]+/g, '-');
}

/**
 * Recursively list files under a directory.
 *
 * @param dir - Directory to walk. A missing directory yields an empty list.
 * @param extension - File extension to match, including the leading dot.
 * @param recurse - Whether to descend into subdirectories.
 * @returns Absolute paths, sorted for deterministic output.
 */
export async function listFiles(
  dir: string,
  extension: string,
  recurse = true,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recurse && !IGNORED_DIRS.has(entry.name)) {
        found.push(...(await listFiles(full, extension, recurse)));
      }
      continue;
    }
    if (entry.name.endsWith(extension)) {
      found.push(full);
    }
  }
  return found.sort();
}

/**
 * Verify that every required document exists and carries real content.
 *
 * @param options - Check inputs.
 * @returns Findings with rule `required-doc`.
 */
export async function checkRequiredDocs(options: DocsCheckOptions): Promise<DocsFinding[]> {
  const required = options.requiredDocs ?? REQUIRED_DOCS;
  const findings: DocsFinding[] = [];

  for (const relative of required) {
    const absolute = path.join(options.root, relative);
    let size: number;
    try {
      size = (await stat(absolute)).size;
    } catch {
      findings.push({
        rule: 'required-doc',
        file: relative,
        message: 'required document is missing',
      });
      continue;
    }
    if (size < MIN_DOC_BYTES) {
      findings.push({
        rule: 'required-doc',
        file: relative,
        message: `required document is a stub (${size} bytes, minimum ${MIN_DOC_BYTES})`,
      });
    }
  }
  return findings;
}

/**
 * Extract the anchor slugs a Markdown document defines through its headings.
 *
 * @param markdown - Full document text.
 * @returns Set of anchor slugs.
 */
export function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  for (const line of markdown.split('\n')) {
    const match = /^#{1,6}\s+(.*)$/.exec(line);
    if (match?.[1] !== undefined) {
      slugs.add(slugify(match[1]));
    }
  }
  return slugs;
}

/**
 * Extract relative Markdown links, ignoring external schemes and fenced code.
 *
 * @param markdown - Full document text.
 * @returns One entry per relative link, with its 1-based line number.
 */
export function relativeLinks(markdown: string): { target: string; line: number }[] {
  const links: { target: string; line: number }[] = [];
  const lines = markdown.split('\n');
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    for (const match of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      if (target === undefined) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      links.push({ target, line: index + 1 });
    }
  }
  return links;
}

/**
 * Verify that relative Markdown links resolve to existing files and anchors.
 *
 * @param options - Check inputs.
 * @returns Findings with rule `link`.
 */
export async function checkMarkdownLinks(options: DocsCheckOptions): Promise<DocsFinding[]> {
  const dirs = options.docDirs ?? ['.', 'docs'];
  const findings: DocsFinding[] = [];
  const files = new Set<string>();

  for (const dir of dirs) {
    const absolute = path.join(options.root, dir);
    for (const file of await listFiles(absolute, '.md', dir !== '.')) {
      files.add(file);
    }
  }

  for (const file of [...files].sort()) {
    const relativeFile = path.relative(options.root, file);
    const markdown = await readFile(file, 'utf8');

    for (const link of relativeLinks(markdown)) {
      const [targetPath = '', anchor] = link.target.split('#');
      const resolved =
        targetPath === '' ? file : path.resolve(path.dirname(file), targetPath);

      let targetText: string;
      try {
        targetText = await readFile(resolved, 'utf8');
      } catch {
        try {
          if ((await stat(resolved)).isDirectory()) continue;
        } catch {
          /* fall through to the finding below */
        }
        findings.push({
          rule: 'link',
          file: relativeFile,
          line: link.line,
          message: `link target does not exist: ${link.target}`,
        });
        continue;
      }

      if (anchor !== undefined && anchor !== '' && !headingSlugs(targetText).has(anchor)) {
        findings.push({
          rule: 'link',
          file: relativeFile,
          line: link.line,
          message: `link anchor does not exist: ${link.target}`,
        });
      }
    }
  }
  return findings;
}

/**
 * Report top-level exports that have no preceding TSDoc comment.
 *
 * Line-oriented on purpose: an export at column zero is the public surface, and a
 * TSDoc block is expected to close on the line above it.
 *
 * @param source - Full text of a TypeScript source file.
 * @returns 1-based line numbers of undocumented exports, with their declaration text.
 */
export function undocumentedExports(source: string): { line: number; text: string }[] {
  const lines = source.split('\n');
  const undocumented: { line: number; text: string }[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!/^export\b/.test(line)) continue;
    if (/^export\s+\*/.test(line)) continue;

    let previous = index - 1;
    while (previous >= 0 && (lines[previous] ?? '').trim() === '') previous -= 1;

    const previousText = previous >= 0 ? (lines[previous] ?? '').trim() : '';
    if (!previousText.endsWith('*/')) {
      undocumented.push({ line: index + 1, text: line.trim() });
    }
  }
  return undocumented;
}

/**
 * Verify that every exported symbol in the source tree is documented.
 *
 * @param options - Check inputs.
 * @returns Findings with rule `export-doc`.
 */
export async function checkExportDocs(options: DocsCheckOptions): Promise<DocsFinding[]> {
  const dirs = options.sourceDirs ?? ['src'];
  const findings: DocsFinding[] = [];

  for (const dir of dirs) {
    for (const file of await listFiles(path.join(options.root, dir), '.ts')) {
      if (file.endsWith('.test.ts')) continue;
      const source = await readFile(file, 'utf8');
      for (const item of undocumentedExports(source)) {
        findings.push({
          rule: 'export-doc',
          file: path.relative(options.root, file),
          line: item.line,
          message: `exported symbol has no TSDoc comment: ${item.text}`,
        });
      }
    }
  }
  return findings;
}

/**
 * Read the body of a generated block from a document.
 *
 * @param markdown - Full document text.
 * @param id - Block identifier used in the begin and end markers.
 * @returns The block body, or `null` when the block is absent or unterminated.
 */
export function generatedBlockBody(markdown: string, id: string): string | null {
  const begin = markdown.indexOf(`<!-- ${GENERATED_BEGIN}:${id} -->`);
  const end = markdown.indexOf(`<!-- ${GENERATED_END}:${id} -->`);
  if (begin === -1 || end === -1 || end < begin) return null;
  const bodyStart = markdown.indexOf('\n', begin);
  if (bodyStart === -1 || bodyStart > end) return '';
  return markdown.slice(bodyStart + 1, end).trim();
}

/**
 * List the generated-block identifiers a document declares.
 *
 * @param markdown - Full document text.
 * @returns Block identifiers, in document order.
 */
export function generatedBlockIds(markdown: string): string[] {
  const ids: string[] = [];
  for (const match of markdown.matchAll(
    new RegExp(`<!-- ${GENERATED_BEGIN}:([A-Za-z0-9._-]+) -->`, 'g'),
  )) {
    if (match[1] !== undefined) ids.push(match[1]);
  }
  return ids;
}

/**
 * Verify that generated documentation blocks match their generator output.
 *
 * A generator for block `<id>` is a module at `scripts/generators/<id>.mjs` exporting
 * `generate(root): Promise<string> | string`. Documents without generated blocks are
 * unaffected, so the mechanism stays inert until contract documents adopt it.
 *
 * @param options - Check inputs.
 * @returns Findings with rule `generated-block`.
 */
export async function checkGeneratedBlocks(options: DocsCheckOptions): Promise<DocsFinding[]> {
  const dirs = options.docDirs ?? ['.', 'docs'];
  const findings: DocsFinding[] = [];

  for (const dir of dirs) {
    const absolute = path.join(options.root, dir);
    for (const file of await listFiles(absolute, '.md', dir !== '.')) {
      const relativeFile = path.relative(options.root, file);
      const markdown = await readFile(file, 'utf8');

      for (const id of generatedBlockIds(markdown)) {
        const body = generatedBlockBody(markdown, id);
        if (body === null) {
          findings.push({
            rule: 'generated-block',
            file: relativeFile,
            message: `generated block "${id}" is not terminated`,
          });
          continue;
        }

        const generatorPath = path.join(options.root, 'scripts', 'generators', `${id}.mjs`);
        let generate: (root: string) => Promise<string> | string;
        try {
          const module = (await import(pathToFileURL(generatorPath).href)) as {
            generate: (root: string) => Promise<string> | string;
          };
          generate = module.generate;
        } catch {
          findings.push({
            rule: 'generated-block',
            file: relativeFile,
            message: `no generator found for block "${id}" (expected scripts/generators/${id}.mjs)`,
          });
          continue;
        }

        const expected = (await generate(options.root)).trim();
        if (expected !== body) {
          findings.push({
            rule: 'generated-block',
            file: relativeFile,
            message: `generated block "${id}" is out of date; run npm run docs:gen`,
          });
        }
      }
    }
  }
  return findings;
}

/**
 * Run every documentation-coverage rule.
 *
 * @param options - Check inputs.
 * @returns All findings, grouped by rule in the order the rules are documented.
 */
export async function checkDocs(options: DocsCheckOptions): Promise<DocsFinding[]> {
  return [
    ...(await checkRequiredDocs(options)),
    ...(await checkMarkdownLinks(options)),
    ...(await checkExportDocs(options)),
    ...(await checkGeneratedBlocks(options)),
  ];
}

/**
 * Render findings as human-readable lines.
 *
 * @param findings - Findings to render.
 * @returns A report ending in a summary line.
 */
export function formatFindings(findings: readonly DocsFinding[]): string {
  if (findings.length === 0) return 'docs:check passed — 0 findings';

  const lines = findings.map((finding) => {
    const where = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
    return `${where} [${finding.rule}] ${finding.message}`;
  });
  lines.push(`docs:check failed — ${findings.length} finding(s)`);
  return lines.join('\n');
}
