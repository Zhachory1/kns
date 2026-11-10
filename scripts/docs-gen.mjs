#!/usr/bin/env node
/**
 * Regenerate every generated block in the documentation.
 *
 * Run this after changing a documented surface, then commit the result. CI runs
 * docs:check, which diffs the committed block against fresh generator output.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { GENERATED_BEGIN, GENERATED_END, generatedBlockIds } from '../src/tools/docs-check.ts';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const docsDir = path.join(root, 'docs');
const files = [path.join(root, 'README.md')];

for (const entry of await readdir(docsDir, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.md')) files.push(path.join(docsDir, entry.name));
}

let updated = 0;

for (const file of files) {
  let markdown = await readFile(file, 'utf8');
  let changed = false;

  for (const id of generatedBlockIds(markdown)) {
    const module = await import(pathToFileURL(path.join(root, 'scripts', 'generators', `${id}.mjs`)).href);
    const body = (await module.generate(root)).trim();

    const begin = `<!-- ${GENERATED_BEGIN}:${id} -->`;
    const end = `<!-- ${GENERATED_END}:${id} -->`;
    const pattern = new RegExp(`${begin}[\\s\\S]*?${end}`);

    const replacement = `${begin}\n${body}\n${end}`;
    if (!pattern.test(markdown)) continue;

    const next = markdown.replace(pattern, replacement);
    if (next !== markdown) {
      markdown = next;
      changed = true;
    }
  }

  if (changed) {
    await writeFile(file, markdown, 'utf8');
    updated += 1;
    console.log(`regenerated ${path.relative(root, file)}`);
  }
}

console.log(`docs:gen complete — ${updated} file(s) updated`);
