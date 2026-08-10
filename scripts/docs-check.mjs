#!/usr/bin/env node
/**
 * CLI entry point for the documentation-coverage gate.
 *
 * All logic lives in `src/tools/docs-check.ts` so that it is type-checked and covered
 * by tests; this file only wires it to a process exit code.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkDocs, formatFindings } from '../src/tools/docs-check.ts';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const findings = await checkDocs({ root });

console.log(formatFindings(findings));
process.exitCode = findings.length === 0 ? 0 : 1;
