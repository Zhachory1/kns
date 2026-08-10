/**
 * Minimal command-line argument parsing.
 *
 * Deliberately small: KNS commands take a subcommand path and named flags, and
 * nothing else. A parser that also handles short flags, negation, and clustering
 * would be more code than the commands it serves.
 *
 * @module
 */

/** A parsed command line. */
export interface ParsedArgs {
  /** Positional arguments, in order — the subcommand path and its operands. */
  positional: string[];
  /** Named flags. A flag without a value is `true`. */
  flags: Map<string, string | boolean>;
}

/**
 * Parse an argument vector.
 *
 * Supports `--name value`, `--name=value`, and bare `--name`. Everything after a
 * lone `--` is positional, so a query can contain leading dashes.
 *
 * @param argv - Arguments, excluding the executable and script paths.
 * @returns The parsed command line.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  let literal = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';

    if (literal) {
      positional.push(token);
      continue;
    }
    if (token === '--') {
      literal = true;
      continue;
    }
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const body = token.slice(2);
    const equals = body.indexOf('=');
    if (equals !== -1) {
      flags.set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }

    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(body, next);
      index += 1;
      continue;
    }
    flags.set(body, true);
  }

  return { positional, flags };
}

/**
 * Read a flag as a string.
 *
 * @param args - Parsed command line.
 * @param name - Flag name, without leading dashes.
 * @returns The value, or null when absent or given without a value.
 */
export function flagString(args: ParsedArgs, name: string): string | null {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : null;
}

/**
 * Read a flag as a number.
 *
 * @param args - Parsed command line.
 * @param name - Flag name, without leading dashes.
 * @returns The parsed number, `null` when absent, or `NaN` when unparseable.
 */
export function flagNumber(args: ParsedArgs, name: string): number | null {
  const value = flagString(args, name);
  if (value === null) return null;
  return Number(value);
}

/**
 * Read a flag as a boolean.
 *
 * @param args - Parsed command line.
 * @param name - Flag name, without leading dashes.
 * @returns True when the flag is present as a switch or as `true`.
 */
export function flagBoolean(args: ParsedArgs, name: string): boolean {
  const value = args.flags.get(name);
  return value === true || value === 'true';
}

/**
 * List flags that the command does not understand.
 *
 * Unknown flags are reported rather than ignored, for the same reason unknown fields
 * are rejected in the registry: a silently dropped `--scope` is a wrong answer that
 * looks like a right one.
 *
 * @param args - Parsed command line.
 * @param known - Flags the command accepts.
 * @returns Unknown flag names, sorted.
 */
export function unknownFlags(args: ParsedArgs, known: readonly string[]): string[] {
  return [...args.flags.keys()].filter((name) => !known.includes(name)).sort();
}
