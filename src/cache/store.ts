/**
 * TTL cache for results from remote zones.
 *
 * This is the TTL half of the DNS analogy: serve a shared zone's answer from a local
 * copy until it expires or its source changes, so cross-zone latency stays off the
 * hot path.
 *
 * The design note proposed keying on `(zone, chunkId, sourceVersion)`. That key suits
 * a fetch-by-id path, but resolution is query-driven — nothing knows which chunk ids
 * to look up before a search has run. The cache therefore keys on
 * `(zone, query, k)` and carries the zone's index generation as the version
 * component, which is what actually removes the round trip. Chunk-level caching would
 * only help `kns get`, which is already a single bounded call.
 *
 * The store is deliberately failure-tolerant: a caching layer must never be able to
 * take retrieval down, so a corrupt database is rebuilt rather than thrown.
 *
 * @module
 */

import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Hit } from '../core/types.ts';

/** Default cap on cached entries before least-recently-used eviction. */
export const DEFAULT_MAX_ENTRIES = 5000;

/** Summary of what the cache holds. */
export interface CacheStats {
  /** Total cached entries. */
  entries: number;
  /** Entries per zone, by zone name. */
  byZone: Record<string, number>;
  /** Reads served from the cache since this process opened it. */
  hits: number;
  /** Reads that had to go to a zone since this process opened it. */
  misses: number;
}

/** File name of the cache inside the KNS home directory. */
export const CACHE_FILE = 'cache.sqlite';

/** Schema applied on open. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS zone_results (
  zone TEXT NOT NULL,
  query TEXT NOT NULL,
  k INTEGER NOT NULL,
  generation TEXT NOT NULL,
  hits TEXT NOT NULL,
  stored_at INTEGER NOT NULL,
  last_used INTEGER NOT NULL,
  PRIMARY KEY (zone, query, k)
);
CREATE INDEX IF NOT EXISTS zone_results_last_used ON zone_results (last_used);
`;

/** A local, bounded cache of remote zone results. */
export class HitCache {
  #db: DatabaseSync;
  #file: string;
  #maxEntries: number;
  #hits = 0;
  #misses = 0;

  /**
   * @param file - Path to the SQLite file, or `:memory:` for an ephemeral cache.
   * @param maxEntries - Cap before least-recently-used eviction.
   */
  constructor(file: string, maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.#file = file;
    this.#maxEntries = maxEntries;
    this.#db = this.#open();
  }

  /** Open the database, rebuilding it if the existing file is unusable. */
  #open(): DatabaseSync {
    if (this.#file !== ':memory:') {
      mkdirSync(path.dirname(this.#file), { recursive: true });
    }

    try {
      const db = new DatabaseSync(this.#file);
      db.exec(SCHEMA);
      return db;
    } catch {
      // A corrupt cache is a recoverable condition, not a fatal one: drop it and
      // start clean rather than failing every retrieval that touches a shared zone.
      if (this.#file !== ':memory:') rmSync(this.#file, { force: true });
      const db = new DatabaseSync(this.#file);
      db.exec(SCHEMA);
      return db;
    }
  }

  /**
   * Read cached hits for a query.
   *
   * @param zone - Zone name.
   * @param query - Query text.
   * @param k - Result count the entry was stored for.
   * @param generation - Current index generation reported by the zone, or null.
   * @param ttlSeconds - Zone TTL. Zero disables caching entirely.
   * @param nowMs - Reference time in epoch milliseconds.
   * @returns The cached hits, or null on a miss, an expiry, or a generation change.
   */
  get(
    zone: string,
    query: string,
    k: number,
    generation: string | null,
    ttlSeconds: number,
    nowMs: number = Date.now(),
  ): Hit[] | null {
    if (ttlSeconds <= 0) {
      this.#misses += 1;
      return null;
    }

    const row = this.#db
      .prepare('SELECT generation, hits, stored_at FROM zone_results WHERE zone = ? AND query = ? AND k = ?')
      .get(zone, query, k) as { generation: string; hits: string; stored_at: number } | undefined;

    if (row === undefined) {
      this.#misses += 1;
      return null;
    }

    const expired = nowMs - row.stored_at > ttlSeconds * 1000;
    const moved = row.generation !== (generation ?? '');
    if (expired || moved) {
      // A generation change invalidates immediately rather than waiting out the TTL:
      // the zone has already told us the answer changed.
      this.#db.prepare('DELETE FROM zone_results WHERE zone = ? AND query = ? AND k = ?').run(zone, query, k);
      this.#misses += 1;
      return null;
    }

    this.#db
      .prepare('UPDATE zone_results SET last_used = ? WHERE zone = ? AND query = ? AND k = ?')
      .run(nowMs, zone, query, k);
    this.#hits += 1;

    try {
      return JSON.parse(row.hits) as Hit[];
    } catch {
      this.#hits -= 1;
      this.#misses += 1;
      return null;
    }
  }

  /**
   * Read a TTL-fresh entry without checking its generation.
   *
   * Resolution uses this to avoid a needless round trip: the generation can only be
   * learned by asking the zone, and asking is worth it only when there is a
   * TTL-fresh entry to revalidate in the first place.
   *
   * @param zone - Zone name.
   * @param query - Query text.
   * @param k - Result count the entry was stored for.
   * @param ttlSeconds - Zone TTL. Zero disables caching entirely.
   * @param nowMs - Reference time in epoch milliseconds.
   * @returns The entry and the generation it was stored under, or null.
   */
  peek(
    zone: string,
    query: string,
    k: number,
    ttlSeconds: number,
    nowMs: number = Date.now(),
  ): { hits: Hit[]; generation: string } | null {
    if (ttlSeconds <= 0) return null;

    const row = this.#db
      .prepare('SELECT generation, hits, stored_at FROM zone_results WHERE zone = ? AND query = ? AND k = ?')
      .get(zone, query, k) as { generation: string; hits: string; stored_at: number } | undefined;

    if (row === undefined) return null;
    if (nowMs - row.stored_at > ttlSeconds * 1000) return null;

    try {
      return { hits: JSON.parse(row.hits) as Hit[], generation: row.generation };
    } catch {
      return null;
    }
  }

  /**
   * Record that a peeked entry was served.
   *
   * @param zone - Zone name.
   * @param query - Query text.
   * @param k - Result count the entry was stored for.
   * @param nowMs - Reference time in epoch milliseconds.
   */
  touch(zone: string, query: string, k: number, nowMs: number = Date.now()): void {
    this.#hits += 1;
    this.#db
      .prepare('UPDATE zone_results SET last_used = ? WHERE zone = ? AND query = ? AND k = ?')
      .run(nowMs, zone, query, k);
  }

  /**
   * Store hits for a query.
   *
   * @param zone - Zone name.
   * @param query - Query text.
   * @param k - Result count these hits were produced for.
   * @param generation - Index generation reported by the zone, or null.
   * @param hits - Hits to cache.
   * @param ttlSeconds - Zone TTL. Zero means do not cache.
   * @param nowMs - Reference time in epoch milliseconds.
   */
  put(
    zone: string,
    query: string,
    k: number,
    generation: string | null,
    hits: readonly Hit[],
    ttlSeconds: number,
    nowMs: number = Date.now(),
  ): void {
    if (ttlSeconds <= 0) return;

    this.#db
      .prepare(
        `INSERT INTO zone_results (zone, query, k, generation, hits, stored_at, last_used)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(zone, query, k) DO UPDATE SET
           generation = excluded.generation,
           hits = excluded.hits,
           stored_at = excluded.stored_at,
           last_used = excluded.last_used`,
      )
      .run(zone, query, k, generation ?? '', JSON.stringify(hits), nowMs, nowMs);

    this.#evict();
  }

  /** Drop least-recently-used entries once the cap is exceeded. */
  #evict(): void {
    const row = this.#db.prepare('SELECT COUNT(*) AS count FROM zone_results').get() as {
      count: number;
    };
    if (row.count <= this.#maxEntries) return;

    this.#db
      .prepare(
        `DELETE FROM zone_results WHERE rowid IN (
           SELECT rowid FROM zone_results ORDER BY last_used ASC LIMIT ?
         )`,
      )
      .run(row.count - this.#maxEntries);
  }

  /**
   * Remove cached entries.
   *
   * @param zone - Zone to purge, or null for every zone.
   * @returns Number of entries removed.
   */
  purge(zone: string | null = null): number {
    const before = (this.#db.prepare('SELECT COUNT(*) AS count FROM zone_results').get() as { count: number }).count;

    if (zone === null) this.#db.prepare('DELETE FROM zone_results').run();
    else this.#db.prepare('DELETE FROM zone_results WHERE zone = ?').run(zone);

    const after = (this.#db.prepare('SELECT COUNT(*) AS count FROM zone_results').get() as { count: number }).count;
    return before - after;
  }

  /**
   * Summarise the cache.
   *
   * @returns Entry counts and this process's hit and miss totals.
   */
  stats(): CacheStats {
    const rows = this.#db
      .prepare('SELECT zone, COUNT(*) AS count FROM zone_results GROUP BY zone ORDER BY zone')
      .all() as { zone: string; count: number }[];

    const byZone: Record<string, number> = {};
    let entries = 0;
    for (const row of rows) {
      byZone[row.zone] = row.count;
      entries += row.count;
    }

    return { entries, byZone, hits: this.#hits, misses: this.#misses };
  }

  /** Close the underlying database. */
  close(): void {
    this.#db.close();
  }
}

/**
 * Resolve the cache file path for a KNS home directory.
 *
 * @param home - KNS home directory.
 * @returns Absolute path to the cache file.
 */
export function cachePath(home: string): string {
  return path.join(home, CACHE_FILE);
}
