/**
 * Minimal frontmatter parsing.
 *
 * Only what promotion needs: scalar keys, quoted or bare, plus inline lists. A full
 * YAML parser would be a dependency and an attack surface for the sake of syntax this
 * project never writes. Anything it cannot parse is reported rather than guessed at,
 * because a misread `share:` is the difference between private and published.
 *
 * @module
 */

/** Parsed frontmatter and the body beneath it. */
export interface Document {
  /** Scalar frontmatter fields, in file order. */
  fields: Record<string, string>;
  /** Inline list fields, e.g. `tags: [a, b]`. */
  lists: Record<string, string[]>;
  /** Content after the closing delimiter. */
  body: string;
  /** True when a frontmatter block was present. */
  hasFrontmatter: boolean;
}

/** Strip matching surrounding quotes from a scalar. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Parse a Markdown document with optional frontmatter.
 *
 * @param text - Full file contents.
 * @returns Fields, lists, and the body.
 */
export function parseDocument(text: string): Document {
  const normalised = text.replace(/\r\n/g, '\n');
  const empty: Document = { fields: {}, lists: {}, body: normalised, hasFrontmatter: false };

  if (!normalised.startsWith('---\n')) return empty;

  const end = normalised.indexOf('\n---', 3);
  if (end === -1) return empty;

  const block = normalised.slice(4, end);
  const afterDelimiter = normalised.indexOf('\n', end + 1);
  const body = afterDelimiter === -1 ? '' : normalised.slice(afterDelimiter + 1);

  const fields: Record<string, string> = {};
  const lists: Record<string, string[]> = {};

  for (const line of block.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match === null) continue;

    const key = match[1] ?? '';
    const value = (match[2] ?? '').trim();

    if (value.startsWith('[') && value.endsWith(']')) {
      lists[key] = value
        .slice(1, -1)
        .split(',')
        .map((item) => unquote(item))
        .filter((item) => item !== '');
      continue;
    }
    fields[key] = unquote(value);
  }

  return { fields, lists, body, hasFrontmatter: true };
}

/**
 * Render frontmatter and a body back into a document.
 *
 * @param fields - Scalar fields, written in insertion order.
 * @param body - Content to place beneath the block.
 * @returns The rendered document.
 */
export function renderDocument(fields: Record<string, string>, body: string): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join('\n')}\n---\n\n${body.replace(/^\n+/, '')}`;
}

/**
 * Extract wiki-style and Markdown links from a body.
 *
 * @param body - Document body.
 * @returns Link targets, deduplicated, in first-appearance order.
 */
export function extractLinks(body: string): string[] {
  const targets: string[] = [];
  const seen = new Set<string>();

  for (const match of body.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const target = match[1]?.trim();
    if (target !== undefined && target !== '' && !seen.has(target)) {
      seen.add(target);
      targets.push(target);
    }
  }

  for (const match of body.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1]?.trim();
    if (target === undefined || target === '' || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    if (seen.has(target)) continue;
    seen.add(target);
    targets.push(target);
  }

  return targets;
}
