/**
 * Drafting a promotable copy.
 *
 * A draft is a curated copy carrying provenance, not a mirror of the private note.
 * The origin file is never touched here, and nothing is written unless the sanitizer
 * passed.
 *
 * @module
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { KnsError } from '../core/errors.ts';
import type { Zone } from '../core/types.ts';
import { parseDocument, renderDocument } from './frontmatter.ts';
import { formatFindings, sanitize } from './sanitize.ts';
import type { SanitizeOptions, SanitizeResult } from './sanitize.ts';

/** Days a promoted document is trusted before it must be reviewed again. */
export const DEFAULT_REVIEW_DAYS = 180;

/** What a draft would write, before anything touches the disk. */
export interface DraftPlan {
  /** Document identifier within the target zone. */
  documentId: string;
  /** Absolute path the draft would be written to. */
  targetFile: string;
  /** Full contents, provenance frontmatter included. */
  contents: string;
  /** Sanitizer outcome for the source document. */
  sanitizer: SanitizeResult;
}

/** Inputs for building a draft. */
export interface DraftInput {
  /** Identifier of the source document within the private corpus. */
  documentId: string;
  /** Source document text. */
  sourceText: string;
  /** Absolute root of the target zone's checkout. */
  targetRoot: string;
  /** Target zone. */
  zone: Zone;
  /** Who is promoting. */
  promotedBy: string;
  /** Reference time. */
  now: Date;
  /** Review window in days. */
  reviewDays?: number;
  /** Sanitizer options. */
  sanitizeOptions?: SanitizeOptions;
}

/**
 * Resolve a document id inside a zone root, refusing anything that escapes it.
 *
 * A document id arrives from a command line or a suggestion list and is therefore
 * untrusted input used to build a path. Absolute paths, `..` segments, and symlinked
 * escapes are all refused rather than normalised, because a promotion that writes
 * outside its target zone is indistinguishable from an arbitrary file write.
 *
 * @param root - Absolute zone root.
 * @param documentId - Relative document identifier.
 * @returns The absolute path inside the root.
 * @throws {KnsError} When the identifier escapes the root.
 */
export function safeTargetPath(root: string, documentId: string): string {
  if (documentId.trim() === '') {
    throw new KnsError('invalid_request', 'document id is required');
  }
  if (path.isAbsolute(documentId)) {
    throw new KnsError('invalid_request', `document id must be relative: ${documentId}`);
  }
  if (documentId.includes('\0')) {
    throw new KnsError('invalid_request', 'document id contains a null byte');
  }

  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, documentId);

  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new KnsError(
      'invalid_request',
      `document id escapes the zone root: ${documentId}`,
      'use a path relative to the zone, without ".."',
    );
  }
  return resolved;
}

/** Format a date as YYYY-MM-DD. */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Build a draft without writing anything.
 *
 * @param input - Draft inputs.
 * @returns The plan, ready to write.
 * @throws {KnsError} With code `sanitizer_blocked` when the source cannot be promoted.
 */
export function buildDraft(input: DraftInput): DraftPlan {
  // Scan the whole document, frontmatter included: a secret pasted into a metadata
  // field is just as leaked as one in the body.
  const sanitizer = sanitize(input.sourceText, input.sanitizeOptions ?? {});

  if (sanitizer.blocked) {
    throw new KnsError(
      'sanitizer_blocked',
      `promotion refused for ${input.documentId}\n${formatFindings(sanitizer)}`,
      'remove the secret from the source note, not from the draft, and try again',
    );
  }

  // Redact the body only. An owner address in the frontmatter is not an accidental
  // disclosure — it is the point of provenance, the way a reader routes a question
  // back to a person. Redacting it would strip the promoted document of the one field
  // that makes it answerable, and it is visible only to people who can already read
  // the zone.
  const source = parseDocument(input.sourceText);
  const redactedBody = sanitize(source.body, input.sanitizeOptions ?? {}).redacted;
  const reviewBy = new Date(input.now.getTime());
  reviewBy.setUTCDate(reviewBy.getUTCDate() + (input.reviewDays ?? DEFAULT_REVIEW_DAYS));

  const fields: Record<string, string> = {};
  for (const key of ['title', 'kind', 'type']) {
    const value = source.fields[key];
    if (value !== undefined) fields[key] = value;
  }

  fields['promoted_from'] = input.documentId;
  fields['promoted_by'] = input.promotedBy;
  fields['promoted_at'] = isoDate(input.now);
  fields['origin_owner'] = source.fields['owner'] ?? input.promotedBy;
  fields['review_by'] = isoDate(reviewBy);
  fields['canonical'] = 'true';

  const targetFile = safeTargetPath(input.targetRoot, input.documentId);

  return {
    documentId: input.documentId,
    targetFile,
    contents: renderDocument(fields, redactedBody),
    sanitizer,
  };
}

/**
 * Write a draft to the target zone.
 *
 * @param plan - Plan produced by {@link buildDraft}.
 */
export async function writeDraft(plan: DraftPlan): Promise<void> {
  await mkdir(path.dirname(plan.targetFile), { recursive: true });
  await writeFile(plan.targetFile, plan.contents, 'utf8');
}

/**
 * Read a source document from the private corpus.
 *
 * @param corpusRoot - Absolute corpus root.
 * @param documentId - Document identifier.
 * @returns The file contents.
 * @throws {KnsError} When the document is missing or escapes the corpus.
 */
export async function readSource(corpusRoot: string, documentId: string): Promise<string> {
  const file = safeTargetPath(corpusRoot, documentId);
  try {
    return await readFile(file, 'utf8');
  } catch {
    throw new KnsError(
      'invalid_request',
      `no document "${documentId}" in the private corpus`,
      'run kns promote suggest to see candidates',
    );
  }
}
