/**
 * Promotion candidates.
 *
 * This module reads and ranks; it never writes. A command that both suggests and acts
 * would make the deliberate step accidental, and promotion is the one operation in
 * KNS that cannot be undone by deleting a file.
 *
 * @module
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { extractLinks, parseDocument } from './frontmatter.ts';

/** A local document considered for promotion. */
export interface LocalDocument {
  /** Path relative to the corpus root. */
  id: string;
  /** Absolute path on disk. */
  file: string;
  /** Scalar frontmatter fields. */
  fields: Record<string, string>;
  /** Body text. */
  body: string;
  /** Number of other documents linking here. */
  inboundLinks: number;
}

/** A ranked promotion candidate. */
export interface Suggestion {
  /** Document identifier. */
  documentId: string;
  /** Target zone named by the author, or null when unspecified. */
  requestedScope: string | null;
  /** Score used only for ordering. */
  score: number;
  /** Why this document was suggested, or why it was blocked. */
  reasons: string[];
  /** True when the document must not be promoted as it stands. */
  blocked: boolean;
}

/** Document kinds that carry knowledge worth sharing. */
export const PROMOTABLE_KINDS = ['decision', 'concept', 'solution', 'design', 'runbook'];

/** Document kinds that are working material, not knowledge. */
export const EPHEMERAL_KINDS = ['inbox', 'scratch', 'draft', 'journal', 'meeting'];

/** Directories never scanned. */
const IGNORED = new Set(['node_modules', '.git', '.zbrain', '.kns', 'dist']);

/**
 * Read a Markdown corpus and count inbound links.
 *
 * @param root - Corpus root directory.
 * @returns Every document, with inbound link counts resolved.
 */
export async function readCorpus(root: string): Promise<LocalDocument[]> {
  const files: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED.has(entry.name)) await walk(path.join(dir, entry.name));
        continue;
      }
      if (entry.name.endsWith('.md')) files.push(path.join(dir, entry.name));
    }
  };
  await walk(root);
  files.sort();

  const documents: LocalDocument[] = [];
  const linksBySource = new Map<string, string[]>();

  for (const file of files) {
    const id = path.relative(root, file);
    const parsed = parseDocument(await readFile(file, 'utf8'));
    documents.push({ id, file, fields: parsed.fields, body: parsed.body, inboundLinks: 0 });
    linksBySource.set(id, extractLinks(parsed.body));
  }

  const byBaseName = new Map<string, string>();
  for (const document of documents) {
    byBaseName.set(path.basename(document.id, '.md'), document.id);
  }

  const inbound = new Map<string, number>();
  for (const [source, links] of linksBySource) {
    for (const link of links) {
      // Resolve both `[[slug]]` and a relative path, but never count self-links: a
      // document that references itself is not evidence that anyone else needs it.
      const bySlug = byBaseName.get(link.replace(/\.md$/, ''));
      const byPath = documents.find((document) => document.id === link)?.id;
      const target = byPath ?? bySlug;
      if (target === undefined || target === source) continue;
      inbound.set(target, (inbound.get(target) ?? 0) + 1);
    }
  }

  for (const document of documents) {
    document.inboundLinks = inbound.get(document.id) ?? 0;
  }
  return documents;
}

/**
 * Score one document as a promotion candidate.
 *
 * @param document - Local document.
 * @param now - Reference time, for the review-date check.
 * @param demand - Optional retrieval count from local demand signals.
 * @returns The suggestion, including the reasons behind it.
 */
export function scoreCandidate(
  document: LocalDocument,
  now: Date,
  demand = 0,
): Suggestion {
  const reasons: string[] = [];
  let score = 0;
  let blocked = false;

  const share = document.fields['share'] ?? null;
  const kind = (document.fields['kind'] ?? document.fields['type'] ?? '').toLowerCase();

  if (share !== null && share !== '') {
    score += 100;
    reasons.push(`author tagged share: ${share}`);
  }

  if (PROMOTABLE_KINDS.includes(kind)) {
    score += 20;
    reasons.push(`kind is ${kind}`);
  }
  if (EPHEMERAL_KINDS.includes(kind)) {
    score -= 30;
    reasons.push(`kind ${kind} is working material, not knowledge`);
  }

  if (document.inboundLinks > 0) {
    score += Math.min(20, document.inboundLinks * 5);
    reasons.push(`${document.inboundLinks} inbound link(s)`);
  }

  if (demand > 0) {
    score += Math.min(20, demand * 2);
    reasons.push(`retrieved ${demand} time(s) by teammates`);
  }

  const reviewBy = document.fields['review_by'];
  if (reviewBy !== undefined) {
    const timestamp = Date.parse(reviewBy);
    if (!Number.isNaN(timestamp) && timestamp < now.getTime()) {
      blocked = true;
      reasons.push(`past its own review_by date (${reviewBy}) — refresh it first`);
    }
  }

  if (document.body.trim().length < 200) {
    blocked = true;
    reasons.push('too short to be useful to anyone else');
  }

  return {
    documentId: document.id,
    requestedScope: share,
    score,
    reasons,
    blocked,
  };
}

/**
 * Rank a corpus by promotion-worthiness.
 *
 * @param documents - Local documents.
 * @param now - Reference time.
 * @param demand - Retrieval counts by document id.
 * @returns Suggestions worth showing, best first. Blocked documents are included so
 *          the reason is visible, but never at the top.
 */
export function suggest(
  documents: readonly LocalDocument[],
  now: Date,
  demand: Record<string, number> = {},
): Suggestion[] {
  return documents
    .map((document) => scoreCandidate(document, now, demand[document.id] ?? 0))
    .filter((suggestion) => suggestion.score > 0 || suggestion.blocked)
    .sort((left, right) => {
      if (left.blocked !== right.blocked) return left.blocked ? 1 : -1;
      if (right.score !== left.score) return right.score - left.score;
      return left.documentId.localeCompare(right.documentId);
    });
}
