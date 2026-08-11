/**
 * Package version and the schema version of every wire envelope.
 *
 * @module
 */

/** Package version. Kept in step with `package.json` by a test. */
export const VERSION = '0.0.0';

/**
 * Version of every JSON envelope KNS emits.
 *
 * Consumers branch on this rather than on {@link VERSION}: the package version moves
 * with releases, the schema version moves only when a wire shape changes.
 */
export const SCHEMA_VERSION = 1;

/**
 * Render a one-line version banner.
 *
 * @returns A string such as `kns 0.0.0 (schema 1)`.
 */
export function describeVersion(): string {
  return `kns ${VERSION} (schema ${SCHEMA_VERSION})`;
}
