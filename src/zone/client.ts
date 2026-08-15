/**
 * Zone client interface and the stdio implementation.
 *
 * A zone is reached by spawning its retrieval engine and speaking MCP over stdio. The
 * client owns that child process: one per zone, spawned lazily, reused across calls,
 * and killed if it stops answering.
 *
 * Every call has a deadline. A zone that hangs must degrade the result, never the
 * process — so timeouts escalate SIGTERM to SIGKILL and reject, rather than waiting.
 *
 * @module
 */

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { KnsError } from '../core/errors.ts';
import type { Zone } from '../core/types.ts';
import { MessageFramer, encodeMessage } from './framing.ts';

/** A hit as the zone's engine reported it, before fusion or annotation. */
export interface RawHit {
  /** Document identifier within the zone. */
  documentId: string;
  /** Excerpt of the matching content. */
  snippet: string;
  /** Engine-native score. Not comparable across zones; kept for diagnostics. */
  score: number | null;
  /** Document owner, when the engine reports one. */
  owner: string | null;
  /** ISO date the document was last modified, when the engine reports one. */
  modified: string | null;
  /** Version identifier used for cache invalidation, when available. */
  sourceVersion: string | null;
}

/** A zone's index status. */
export interface ZoneStatus {
  /** Number of indexed documents, or null when the engine does not report it. */
  documents: number | null;
  /** Index generation, used with document hashes to key the cache. */
  generation: string | null;
}

/** Everything the resolver needs from a zone. */
export interface ZoneClient {
  /** The zone this client speaks to. */
  readonly zone: Zone;
  /** Run a search. */
  search(query: string, limit: number, deadlineMs: number): Promise<RawHit[]>;
  /** Fetch a bounded excerpt from a document. */
  get(documentId: string, from: number, lines: number, deadlineMs: number): Promise<string>;
  /** Read index status. */
  status(deadlineMs: number): Promise<ZoneStatus>;
  /** Release the underlying process. Safe to call more than once. */
  close(): Promise<void>;
}

/** MCP protocol version this client negotiates. */
export const PROTOCOL_VERSION = '2024-11-05';

/** A pending request awaiting its response. */
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Read a string property from an unknown record. */
function readString(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/** Read a numeric property from an unknown record. */
function readNumber(source: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Convert an engine's tool payload into {@link RawHit} values.
 *
 * Engines differ in field naming, and a zone is a trust boundary: anything missing or
 * mistyped becomes null rather than throwing, so one odd zone cannot fail a query that
 * other zones can answer.
 *
 * @param payload - Decoded tool result.
 * @returns Hits in the order the engine returned them.
 */
export function toRawHits(payload: unknown): RawHit[] {
  const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  const candidates = record['results'] ?? record['hits'] ?? record['documents'] ?? payload;
  if (!Array.isArray(candidates)) return [];

  const hits: RawHit[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const source = candidate as Record<string, unknown>;

    const documentId = readString(source, ['documentId', 'id', 'path', 'document']);
    if (documentId === null) continue;

    hits.push({
      documentId,
      snippet: readString(source, ['snippet', 'excerpt', 'text', 'body']) ?? '',
      score: readNumber(source, ['score', 'rank_score', 'relevance']),
      owner: readString(source, ['owner', 'origin_owner']),
      modified: readString(source, ['modified', 'updatedAt', 'mtime', 'date']),
      sourceVersion: readString(source, ['sourceVersion', 'hash', 'contentHash', 'version']),
    });
  }
  return hits;
}

/**
 * Decode the text payload carried by an MCP content block.
 *
 * @param result - Value of a `tools/call` result.
 * @returns The parsed payload, or the raw result when it is not a content envelope.
 */
export function decodeToolResult(result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return result;
  const record = result as Record<string, unknown>;

  const content = record['content'];
  if (!Array.isArray(content)) return result;

  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const text = (block as Record<string, unknown>)['text'];
    if (typeof text !== 'string') continue;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result;
}

/** A zone client backed by a child process speaking MCP over stdio. */
export class StdioZoneClient implements ZoneClient {
  /** The zone this client speaks to. */
  readonly zone: Zone;

  #child: ChildProcessWithoutNullStreams | null = null;
  #framer = new MessageFramer();
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #handshake: Promise<void> | null = null;
  #closed = false;

  /**
   * @param zone - Registry entry describing the zone and how to reach it.
   */
  constructor(zone: Zone) {
    this.zone = zone;
  }

  /**
   * Run a search against the zone.
   *
   * @param query - Free-text query.
   * @param limit - Maximum hits to request.
   * @param deadlineMs - Deadline for this call.
   * @returns Hits in engine order.
   */
  async search(query: string, limit: number, deadlineMs: number): Promise<RawHit[]> {
    const result = await this.#call('tools/call', { name: 'zbrain.search', arguments: { query, limit } }, deadlineMs);
    return toRawHits(decodeToolResult(result));
  }

  /**
   * Fetch a bounded excerpt.
   *
   * @param documentId - Document identifier within the zone.
   * @param from - First line, one-based.
   * @param lines - Number of lines to read.
   * @param deadlineMs - Deadline for this call.
   * @returns The excerpt text.
   */
  async get(documentId: string, from: number, lines: number, deadlineMs: number): Promise<string> {
    const result = await this.#call(
      'tools/call',
      { name: 'zbrain.get', arguments: { id: documentId, from, lines } },
      deadlineMs,
    );
    const payload = decodeToolResult(result);
    if (typeof payload === 'string') return payload;
    const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
    return readString(record, ['text', 'body', 'excerpt', 'content']) ?? '';
  }

  /**
   * Read index status.
   *
   * @param deadlineMs - Deadline for this call.
   * @returns Document count and index generation, where reported.
   */
  async status(deadlineMs: number): Promise<ZoneStatus> {
    const result = await this.#call('tools/call', { name: 'zbrain.status', arguments: {} }, deadlineMs);
    const payload = decodeToolResult(result);
    const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
    const status = (record['status'] ?? record) as Record<string, unknown>;

    return {
      documents: readNumber(status, ['documents', 'documentCount']),
      generation: readString(status, ['generation', 'indexedAt', 'dbPath']),
    };
  }

  /** Terminate the child process and reject anything still in flight. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#failPending(new KnsError('zone_unavailable', `zone "${this.zone.name}" was closed`));

    const child = this.#child;
    this.#child = null;
    this.#handshake = null;
    if (child === null) return;

    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      child.once('exit', done);
      child.kill('SIGTERM');
      // A child that ignores SIGTERM must not keep the process alive.
      const escalation = setTimeout(() => child.kill('SIGKILL'), 200);
      escalation.unref();
      setTimeout(done, 1000).unref();
    });
  }

  /** Spawn the child and complete the MCP handshake, at most once. */
  async #connect(): Promise<void> {
    if (this.#closed) {
      throw new KnsError('zone_unavailable', `zone "${this.zone.name}" is closed`);
    }
    if (this.#handshake !== null) return this.#handshake;

    this.#handshake = (async () => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.zone.transport.command, this.zone.transport.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        throw new KnsError(
          'zone_unavailable',
          `could not start zone "${this.zone.name}": ${error instanceof Error ? error.message : String(error)}`,
          'check transport.command in your registry',
        );
      }

      this.#child = child;
      child.stdout.on('data', (chunk: Buffer) => this.#onData(chunk));
      child.stderr.resume();
      child.on('error', (error: Error) => {
        this.#failPending(
          new KnsError(
            'zone_unavailable',
            `zone "${this.zone.name}" failed to start: ${error.message}`,
            'check transport.command in your registry',
          ),
        );
      });
      child.on('exit', (code) => {
        this.#failPending(
          new KnsError('zone_unavailable', `zone "${this.zone.name}" exited with code ${code ?? 'null'}`),
        );
      });

      await this.#call(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: 'kns', version: '0.0.0' },
          capabilities: {},
        },
        5000,
        true,
      );
      this.#notify('notifications/initialized');
    })();

    try {
      await this.#handshake;
    } catch (error) {
      this.#handshake = null;
      throw error;
    }
  }

  /** Handle bytes from the child, dispatching complete messages to their callers. */
  #onData(chunk: Buffer): void {
    let bodies: string[];
    try {
      bodies = this.#framer.push(chunk);
    } catch (error) {
      this.#failPending(
        new KnsError(
          'zone_unavailable',
          `zone "${this.zone.name}" sent an oversized message: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }

    for (const body of bodies) {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(body) as Record<string, unknown>;
      } catch {
        // A zone that emits noise on stdout must not poison well-formed traffic.
        continue;
      }

      const id = message['id'];
      if (typeof id !== 'number') continue;
      const pending = this.#pending.get(id);
      if (pending === undefined) continue;

      this.#pending.delete(id);
      clearTimeout(pending.timer);

      const error = message['error'];
      if (error !== undefined && error !== null) {
        const detail = typeof error === 'object' ? JSON.stringify(error) : String(error);
        pending.reject(new KnsError('zone_unavailable', `zone "${this.zone.name}" returned an error: ${detail}`));
        continue;
      }
      pending.resolve(message['result']);
    }
  }

  /** Reject every in-flight request with the same error. */
  #failPending(error: Error): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  /** Send a notification, which expects no response. */
  #notify(method: string): void {
    this.#child?.stdin.write(encodeMessage({ jsonrpc: '2.0', method }));
  }

  /** Send a request and await its response, subject to a deadline. */
  async #call(
    method: string,
    params: unknown,
    deadlineMs: number,
    duringHandshake = false,
  ): Promise<unknown> {
    if (!duringHandshake) await this.#connect();

    const child = this.#child;
    if (child === null) {
      throw new KnsError('zone_unavailable', `zone "${this.zone.name}" is not running`);
    }

    const id = this.#nextId++;
    const message = encodeMessage({ jsonrpc: '2.0', id, method, params });

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        // The zone is unresponsive, not merely slow: reclaim the process so the next
        // query starts from a known state instead of queueing behind a hung call.
        void this.close();
        reject(
          new KnsError(
            'zone_timeout',
            `zone "${this.zone.name}" did not answer ${method} within ${deadlineMs}ms`,
            'raise zoneDeadlineMs, or check that the zone index is built',
          ),
        );
      }, deadlineMs);
      timer.unref();

      this.#pending.set(id, { resolve, reject, timer });
      child.stdin.write(message, (error) => {
        if (!error) return;
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(new KnsError('zone_unavailable', `zone "${this.zone.name}" stdin failed: ${error.message}`));
      });
    });
  }
}
