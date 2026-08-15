/**
 * Domain types shared by every KNS component.
 *
 * These describe the wire surface: what a zone is, what a hit is, and what an agent
 * or CLI caller receives. Nothing here performs I/O, so the module stays trivially
 * testable and safe to import from anywhere.
 *
 * @module
 */

/** Tier labels, ordered from nearest to furthest. Routing uses distance, not this. */
export const TIERS = ['USER', 'TEAM', 'COMPANY'] as const;

/** A zone's tier label. */
export type Tier = (typeof TIERS)[number];

/**
 * Narrow an arbitrary value to a {@link Tier}.
 *
 * @param value - Candidate value.
 * @returns True when the value is a known tier label.
 */
export function isTier(value: unknown): value is Tier {
  return typeof value === 'string' && (TIERS as readonly string[]).includes(value);
}

/** Transport kinds a zone can be reached over. Only stdio is supported in 0.1.0. */
export const TRANSPORT_KINDS = ['stdio'] as const;

/** A zone transport kind. */
export type TransportKind = (typeof TRANSPORT_KINDS)[number];

/** How to reach a zone's retrieval engine. */
export interface Transport {
  /** Transport mechanism. Only `stdio` exists today. */
  kind: TransportKind;
  /** Executable to spawn, typically `zbrain-mcp`. */
  command: string;
  /** Arguments passed to the executable, typically `['--root', path]`. */
  args: string[];
}

/** One addressable corpus, with its index, its access boundary, and its policy. */
export interface Zone {
  /** Unique identifier within the registry. */
  name: string;
  /** Dotted-path namespace, e.g. `company/platform`. */
  namespace: string;
  /** Tier label. */
  tier: Tier;
  /** Routing distance. Zero is nearest; zones may share a distance. */
  distance: number;
  /** How to reach the zone. */
  transport: Transport;
  /** Cache lifetime for this zone's hits, in seconds. Zero disables caching. */
  ttlSeconds: number;
  /** Freshness half-life, in days, used by the ranking decay. */
  halfLifeDays: number;
  /** Person or group answerable for the zone, or null when unowned. */
  owner: string | null;
  /** Git remote used by `kns zone sync`, or null for a local-only zone. */
  sourceRepo: string | null;
  /** When true, the resolution walk never stops at this zone. */
  neverEarlyExit: boolean;
}

/** Where a hit came from and how much to trust it. */
export interface Provenance {
  /** Name of the zone that returned the hit. */
  zone: string;
  /** Namespace of that zone. */
  namespace: string;
  /** Tier label of that zone. */
  tier: Tier;
  /** Routing distance of that zone. */
  distance: number;
  /** Owner of the document, or of the zone when the document names none. */
  owner: string | null;
  /** Age of the document in days, or null when no date could be determined. */
  ageDays: number | null;
  /** True once the document has passed its `review_by` date. */
  pastReviewTtl: boolean;
}

/** A single retrieved chunk, annotated with everything needed to judge it. */
export interface Hit {
  /** Document identifier, unique within its zone. */
  documentId: string;
  /** Excerpt returned by the zone. */
  snippet: string;
  /** One-based rank the zone itself assigned, before fusion. */
  rankWithinZone: number;
  /** Fused score. Comparable within one response, meaningless across responses. */
  score: number;
  /** Origin and trust metadata. */
  provenance: Provenance;
  /** Other zones that returned the same document, after deduplication. */
  alsoIn: string[];
  /** True when another zone holds a conflicting version of this document. */
  conflict: boolean;
}

/** A non-fatal problem encountered while resolving. */
export interface Warning {
  /** Machine-readable reason, reusing the error code vocabulary. */
  code: string;
  /** Zone the warning concerns, when it concerns one. */
  zone: string | null;
  /** Human-readable detail. */
  message: string;
}

/** The payload of a successful resolution. */
export interface ResolveResult {
  /** Ranked hits, best first. */
  hits: Hit[];
  /** Names of the zones actually queried, in the order the walk reached them. */
  zonesQueried: string[];
  /** Distance at which the walk stopped early, or null when it ran to completion. */
  earlyExitAt: number | null;
  /** Why the walk stopped where it did, surfaced by `--explain`. */
  explanation: string;
  /** True when at least one zone failed or timed out. */
  partial: boolean;
  /** Wall-clock duration of the resolution, in milliseconds. */
  resolveMs: number;
  /** Non-fatal problems. Empty on a clean resolution. */
  warnings: Warning[];
}

/** Retrieval breadth requested by a caller. */
export const RESOLVE_MODES = ['exact', 'broad'] as const;

/** A retrieval mode. `broad` disables early exit. */
export type ResolveMode = (typeof RESOLVE_MODES)[number];

/** A validated resolution request. */
export interface ResolveRequest {
  /** Free-text query. */
  query: string;
  /** Maximum hits to return. */
  k: number;
  /** Retrieval breadth. */
  mode: ResolveMode;
  /** Namespace prefix to restrict the walk to, or null for the whole tree. */
  scope: string | null;
  /** When true, the walk queries every zone regardless of early-exit policy. */
  noEarlyExit: boolean;
}

/** A successful envelope. */
export interface OkEnvelope<T> {
  /** Wire schema version. */
  schemaVersion: number;
  /** Discriminator. */
  ok: true;
  /** Payload. */
  result: T;
}

/** Machine-readable failure detail. */
export interface ErrorDetail {
  /** Stable error code. */
  code: string;
  /** Human-readable message. */
  message: string;
  /** True when retrying the same request could succeed. */
  retryable: boolean;
  /** Suggested next action for the caller, when there is a useful one. */
  nextStep: string | null;
}

/** A failure envelope. */
export interface ErrorEnvelope {
  /** Wire schema version. */
  schemaVersion: number;
  /** Discriminator. */
  ok: false;
  /** Failure detail. */
  error: ErrorDetail;
}

/** Either envelope, discriminated by `ok`. */
export type Envelope<T> = OkEnvelope<T> | ErrorEnvelope;
