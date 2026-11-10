/**
 * Synthetic three-zone corpus for the evaluation harness.
 *
 * The point of these fixtures is not to look like a real corpus — it is to encode the
 * cases where a hierarchy can plausibly get the answer wrong, with the correct
 * authority known by construction. Anything that only exercises the happy path would
 * pass no matter what the ranker did.
 *
 * @module
 */

import type { Tier } from '../core/types.ts';

/** A document in the synthetic corpus. */
export interface EvalDocument {
  /** Document identifier within its zone. */
  id: string;
  /** Zone that holds it. */
  zone: string;
  /** Body text, matched by the fake engine. */
  text: string;
  /** ISO date used for freshness, relative to {@link EVAL_NOW}. */
  modified: string;
  /** Owner, or null for an unowned shared document. */
  owner: string | null;
  /** True for documents that must never appear outside the private tier. */
  private?: boolean;
}

/** A zone in the synthetic corpus. */
export interface EvalZone {
  /** Zone name. */
  name: string;
  /** Namespace. */
  namespace: string;
  /** Tier label. */
  tier: Tier;
  /** Routing distance. */
  distance: number;
  /** Freshness half-life. */
  halfLifeDays: number;
  /** Zone owner. */
  owner: string | null;
}

/** A query with its known-correct answer. */
export interface EvalQuery {
  /** What the case is testing. */
  name: string;
  /** Query text. */
  query: string;
  /** Document that should rank first. */
  expectedDocumentId: string;
  /** Zone that should have supplied it. */
  expectedZone: string;
  /** Documents that are acceptable anywhere in the top k. */
  relevantDocumentIds: string[];
}

/** Reference time for every age in this corpus. */
export const EVAL_NOW = new Date('2026-08-10T12:00:00.000Z');

/** The three zones. */
export const EVAL_ZONES: EvalZone[] = [
  { name: 'user', namespace: 'user', tier: 'USER', distance: 0, halfLifeDays: 3650, owner: 'me' },
  {
    name: 'team',
    namespace: 'company/platform',
    tier: 'TEAM',
    distance: 1,
    halfLifeDays: 180,
    owner: 'platform-team',
  },
  { name: 'company', namespace: 'company', tier: 'COMPANY', distance: 2, halfLifeDays: 365, owner: 'eng' },
];

/** The corpus. */
export const EVAL_DOCUMENTS: EvalDocument[] = [
  // Case: the answer is genuinely local, fresh, and unambiguous.
  {
    id: 'notes/laptop-setup.md',
    zone: 'user',
    text: 'laptop setup steps install toolchain configure shell dotfiles',
    modified: '2026-08-08T00:00:00.000Z',
    owner: 'me',
  },
  // Case: private content that must never surface from a shared zone.
  {
    id: 'notes/salary-thoughts.md',
    zone: 'user',
    text: 'private compensation thoughts negotiation leverage laptop',
    modified: '2026-08-01T00:00:00.000Z',
    owner: 'me',
    private: true,
  },
  // Case: stale company doc versus fresh team doc on the same topic.
  {
    id: 'runbooks/index-reload.md',
    zone: 'company',
    text: 'index reload procedure swap generation atomic readers',
    modified: '2024-01-01T00:00:00.000Z',
    owner: 'eng',
  },
  {
    id: 'runbooks/index-reload-current.md',
    zone: 'team',
    text: 'index reload procedure swap generation atomic readers current',
    modified: '2026-08-06T00:00:00.000Z',
    owner: 'platform-team',
  },
  // Case: weak local note versus a strong, fresh company document.
  {
    id: 'inbox/retention-scratch.md',
    zone: 'user',
    text: 'retention something something check later',
    modified: '2026-05-01T00:00:00.000Z',
    owner: 'me',
  },
  {
    id: 'policy/data-retention.md',
    zone: 'company',
    text: 'data retention policy ninety days deletion schedule retention',
    modified: '2026-08-01T00:00:00.000Z',
    owner: 'eng',
  },
  // Case: the same document promoted into two zones.
  {
    id: 'concepts/hot-index-reload.md',
    zone: 'team',
    text: 'hot index reload concept generation swap without downtime',
    modified: '2026-07-20T00:00:00.000Z',
    owner: 'platform-team',
  },
  {
    id: 'concepts/hot-index-reload.md',
    zone: 'company',
    text: 'hot index reload concept generation swap without downtime',
    modified: '2026-07-20T00:00:00.000Z',
    owner: 'eng',
  },
  // Case: an unowned, stale shared document competing with an owned one.
  {
    id: 'archive/old-oncall.md',
    zone: 'company',
    text: 'oncall rotation handover escalation paging',
    modified: '2023-02-01T00:00:00.000Z',
    owner: null,
  },
  {
    id: 'runbooks/oncall.md',
    zone: 'team',
    text: 'oncall rotation handover escalation paging current',
    modified: '2026-07-01T00:00:00.000Z',
    owner: 'platform-team',
  },
];

/** The query set. */
export const EVAL_QUERIES: EvalQuery[] = [
  {
    name: 'local answer, fresh and unambiguous',
    query: 'laptop setup dotfiles',
    expectedDocumentId: 'notes/laptop-setup.md',
    expectedZone: 'user',
    relevantDocumentIds: ['notes/laptop-setup.md'],
  },
  {
    name: 'stale company versus fresh team',
    query: 'index reload procedure generation',
    expectedDocumentId: 'runbooks/index-reload-current.md',
    expectedZone: 'team',
    relevantDocumentIds: ['runbooks/index-reload-current.md', 'runbooks/index-reload.md'],
  },
  {
    name: 'weak local versus strong company',
    query: 'data retention policy deletion schedule',
    expectedDocumentId: 'policy/data-retention.md',
    expectedZone: 'company',
    relevantDocumentIds: ['policy/data-retention.md'],
  },
  {
    name: 'same document promoted into two zones',
    query: 'hot index reload concept downtime',
    expectedDocumentId: 'concepts/hot-index-reload.md',
    expectedZone: 'team',
    relevantDocumentIds: ['concepts/hot-index-reload.md'],
  },
  {
    name: 'owned and current beats unowned and archived',
    query: 'oncall rotation handover escalation',
    expectedDocumentId: 'runbooks/oncall.md',
    expectedZone: 'team',
    relevantDocumentIds: ['runbooks/oncall.md', 'archive/old-oncall.md'],
  },
];

/** Documents that must never leave the private tier. */
export const PRIVATE_DOCUMENT_IDS: string[] = EVAL_DOCUMENTS.filter((document) => document.private === true).map(
  (document) => document.id,
);
