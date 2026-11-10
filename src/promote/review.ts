/**
 * The review sweep.
 *
 * Shared-zone rot is what kills precision in a shared index: a zone nobody prunes
 * eventually retrieves worse than a local one, which is the failure this whole system
 * exists to avoid. Ranking already penalises stale, unowned documents so quality
 * degrades gracefully — this is what actually removes them.
 *
 * @module
 */

import { readFile, writeFile } from 'node:fs/promises';

import { parseDocument, renderDocument } from './frontmatter.ts';
import { safeTargetPath } from './draft.ts';
import type { LocalDocument } from './suggest.ts';

/** A promoted document that needs attention. */
export interface ReviewItem {
  /** Document identifier within the zone. */
  documentId: string;
  /** Why it was flagged. */
  reasons: string[];
  /** Review date from the frontmatter, or null when absent. */
  reviewBy: string | null;
  /** Owner from the frontmatter, or null when absent. */
  owner: string | null;
  /** Days past the review date, or null when not applicable. */
  overdueDays: number | null;
}

/** Milliseconds in a day. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Find promoted documents that are past review or have lost their owner.
 *
 * A document with no `review_by` at all is flagged too. An unbounded promotion is the
 * thing that quietly accumulates: nobody schedules a look at a document that never
 * claims to need one.
 *
 * @param documents - Documents in a shared zone.
 * @param now - Reference time.
 * @returns Items needing attention, most overdue first.
 */
export function findStale(documents: readonly LocalDocument[], now: Date): ReviewItem[] {
  const items: ReviewItem[] = [];

  for (const document of documents) {
    const reasons: string[] = [];
    const reviewBy = document.fields['review_by'] ?? null;
    const owner = document.fields['origin_owner'] ?? document.fields['owner'] ?? null;
    let overdueDays: number | null = null;

    if (reviewBy === null) {
      reasons.push('no review_by date — this promotion has no expiry');
    } else {
      const timestamp = Date.parse(reviewBy);
      if (Number.isNaN(timestamp)) {
        reasons.push(`unparseable review_by date "${reviewBy}"`);
      } else if (timestamp < now.getTime()) {
        overdueDays = Math.floor((now.getTime() - timestamp) / DAY_MS);
        reasons.push(`${overdueDays} day(s) past its review date`);
      }
    }

    if (owner === null) {
      reasons.push('no owner — nobody is answerable for it');
    }

    if (reasons.length > 0) {
      items.push({ documentId: document.id, reasons, reviewBy, owner, overdueDays });
    }
  }

  return items.sort((left, right) => {
    const leftDays = left.overdueDays ?? -1;
    const rightDays = right.overdueDays ?? -1;
    return rightDays === leftDays ? left.documentId.localeCompare(right.documentId) : rightDays - leftDays;
  });
}

/**
 * Push a document's review date forward.
 *
 * @param zoneRoot - Zone checkout root.
 * @param documentId - Document to renew.
 * @param now - Reference time.
 * @param days - Days to extend by.
 * @returns The new review date.
 */
export async function renewReview(
  zoneRoot: string,
  documentId: string,
  now: Date,
  days: number,
): Promise<string> {
  const file = safeTargetPath(zoneRoot, documentId);
  const parsed = parseDocument(await readFile(file, 'utf8'));

  const next = new Date(now.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  const reviewBy = next.toISOString().slice(0, 10);

  await writeFile(file, renderDocument({ ...parsed.fields, review_by: reviewBy }, parsed.body), 'utf8');
  return reviewBy;
}
