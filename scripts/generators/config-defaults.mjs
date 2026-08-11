/**
 * Generate the defaults table for docs/configuration.md from the config module.
 *
 * This is the anti-drift mechanism the documentation policy describes: the code is the
 * source of truth, the committed document is the artifact, and docs:check diffs them.
 * Changing a default without regenerating turns CI red.
 */
import { defaultConfig } from '../../src/core/config.ts';

/**
 * Render the current defaults as a Markdown table.
 *
 * @returns The generated block body.
 */
export function generate() {
  const config = defaultConfig();
  const rows = [];

  for (const section of ['resolution', 'ranking', 'earlyExit']) {
    for (const [key, value] of Object.entries(config[section])) {
      rows.push(`| \`${section}.${key}\` | \`${String(value)}\` |`);
    }
  }

  return ['| Key | Default |', '|-----|---------|', ...rows].join('\n');
}
