#!/usr/bin/env node
/**
 * Run the evaluation harness and print the committed readout.
 *
 * Numbers that live only in someone's terminal cannot catch a regression, so the
 * Markdown this prints is what belongs in docs/evals.md.
 */
import { defaultConfig } from '../src/core/config.ts';
import { formatReport, runEval, runUserOnlyBaseline } from '../src/eval/harness.ts';

const config = defaultConfig();
const report = await runEval(config);
const baseline = await runUserOnlyBaseline(config);

console.log(formatReport(report, baseline));

if (report.metrics.leakCount > 0) {
  console.error(`\nleakCount is ${report.metrics.leakCount}; this is a release gate.`);
  process.exitCode = 1;
}
