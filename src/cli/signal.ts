/**
 * The `kns signal` command family.
 *
 * @module
 */

import path from 'node:path';

import { KnsError, ok } from '../core/errors.ts';
import { cachePath } from '../cache/store.ts';
import { DemandStore, aggregate, isoWeek } from '../signal/demand.ts';
import { loadSignalSettings, setSignalEnabled } from '../signal/settings.ts';
import { flagBoolean, flagString, unknownFlags } from './args.ts';
import type { ParsedArgs } from './args.ts';
import type { CliContext } from './zone.ts';

/** Flags accepted by the signal commands. */
const SIGNAL_FLAGS = ['json', 'confirm', 'week'];

/**
 * Run a `kns signal` subcommand.
 *
 * @param args - Parsed command line, positional `['signal', subcommand]`.
 * @param context - Injected home directory and output sink.
 * @returns Zero on success. Failures throw {@link KnsError} for the caller to render.
 */
export async function runSignal(args: ParsedArgs, context: CliContext): Promise<number> {
  const unknown = unknownFlags(args, SIGNAL_FLAGS);
  if (unknown.length > 0) {
    throw new KnsError(
      'invalid_request',
      `unknown flag(s): ${unknown.map((name) => `--${name}`).join(', ')}`,
      'run kns help',
    );
  }

  const subcommand = args.positional[1] ?? 'status';
  const json = flagBoolean(args, 'json');

  if (subcommand === 'enable' || subcommand === 'disable') {
    const settings = await setSignalEnabled(context.home, subcommand === 'enable');
    context.write(
      json
        ? JSON.stringify(ok({ enabled: settings.enabled }), null, 2)
        : `demand signals ${settings.enabled ? 'enabled' : 'disabled'} — counts stay local until you run kns signal export --confirm`,
    );
    return 0;
  }

  const settings = await loadSignalSettings(context.home);
  const store = new DemandStore(cachePath(context.home));

  try {
    if (subcommand === 'status') {
      const rows = store.rows();
      context.write(
        json
          ? JSON.stringify(ok({ enabled: settings.enabled, documents: rows.length }), null, 2)
          : `demand signals: ${settings.enabled ? 'enabled' : 'disabled'} · ${rows.length} document(s) counted locally`,
      );
      return 0;
    }

    if (subcommand === 'stats') {
      const rows = store.rows(flagString(args, 'week'));
      context.write(
        json
          ? JSON.stringify(ok({ rows }), null, 2)
          : rows.length === 0
            ? 'nothing counted yet'
            : rows.map((row) => `${row.count}\t${row.zone}\t${row.documentId}\t${row.week}`).join('\n'),
      );
      return 0;
    }

    if (subcommand === 'export') {
      // Every export is an explicit act. There is no way to configure this away,
      // because "I forgot it was on" is exactly the failure this guards against.
      if (!flagBoolean(args, 'confirm')) {
        throw new KnsError(
          'invalid_request',
          '--confirm is required to export demand signals',
          'run kns signal stats first to see exactly what would leave this machine',
        );
      }
      if (!settings.enabled) {
        throw new KnsError('invalid_request', 'demand signals are disabled', 'kns signal enable');
      }

      const week = flagString(args, 'week') ?? isoWeek(new Date());
      const reports = store.buildExport(settings.secret, week);
      context.write(JSON.stringify(ok({ week, reports }), null, 2));
      return 0;
    }

    if (subcommand === 'purge') {
      const removed = store.purge();
      context.write(json ? JSON.stringify(ok({ removed }), null, 2) : `purged ${removed} counter(s)`);
      return 0;
    }

    if (subcommand === 'aggregate') {
      const file = args.positional[2];
      if (file === undefined) {
        throw new KnsError('invalid_request', 'a reports file is required', 'kns signal aggregate <file.json>');
      }

      const { readFile } = await import('node:fs/promises');
      const parsed = JSON.parse(await readFile(path.resolve(file), 'utf8')) as { reports?: unknown };
      const reports = Array.isArray(parsed.reports) ? parsed.reports : parsed;
      const aggregated = aggregate(reports as Parameters<typeof aggregate>[0]);

      context.write(JSON.stringify(ok({ aggregated }), null, 2));
      return 0;
    }

    throw new KnsError(
      'invalid_request',
      `unknown subcommand "signal ${subcommand}"`,
      'expected one of: status, enable, disable, stats, export, purge, aggregate',
    );
  } finally {
    store.close();
  }
}
