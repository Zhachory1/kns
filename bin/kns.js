#!/usr/bin/env node
/**
 * `kns` executable. All logic lives in src/cli so it is type-checked and tested;
 * this file only binds the process to it.
 */
import { run } from '../src/cli/main.ts';

process.exitCode = await run(process.argv.slice(2), {
  write: (text) => process.stdout.write(`${text}\n`),
  writeError: (text) => process.stderr.write(`${text}\n`),
});
