/**
 * `kns-mcp` — a local stdio MCP server over the whole hierarchy.
 *
 * Drop-in for a single-zone server: point an agent at this instead of `zbrain-mcp`
 * and every zone becomes reachable with no other configuration change.
 *
 * Tool calls never accept a filesystem root. Roots come from the registry, so a
 * prompt-injected tool call cannot redirect retrieval at an arbitrary directory. For
 * the same reason there is no promotion tool: promotion crosses a privacy boundary
 * and needs a human at a terminal, not a model with a tool.
 *
 * @module
 */

import { SCHEMA_VERSION } from '../version.ts';
import type { KnsConfig } from '../core/config.ts';
import { KnsError } from '../core/errors.ts';
import type { Registry } from '../core/registry.ts';
import { findZone } from '../core/registry.ts';
import { issuesToError, parseResolveRequest } from '../core/validate.ts';
import type { HitCache } from '../cache/store.ts';
import type { ZoneClient } from '../zone/client.ts';
import { MessageFramer, encodeMessage } from '../zone/framing.ts';
import { resolve } from '../resolve/resolver.ts';

/** MCP protocol version this server implements. */
export const PROTOCOL_VERSION = '2024-11-05';

/** Largest excerpt a single `kns.get` call may return. */
export const MAX_GET_LINES = 200;

/** Ambient inputs, injected so the server can be tested without spawning anything. */
export interface ServerDeps {
  /** Load the zone registry. */
  loadRegistry: () => Promise<Registry>;
  /** Load settings. */
  loadConfig: () => Promise<KnsConfig>;
  /** Build a client for a zone. */
  createClient: (zone: Registry['zones'][number]) => ZoneClient;
  /** Optional TTL cache. */
  cache?: HitCache;
}

/** A JSON-RPC response. */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Tool descriptors advertised by `tools/list`. */
export const TOOLS = [
  {
    name: 'kns.resolve',
    description:
      'Resolve a query across the zone hierarchy, nearest first. Every hit carries provenance: zone, tier, owner, and age.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text query' },
        k: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum hits (default 10)' },
        mode: { type: 'string', enum: ['exact', 'broad'], description: 'broad queries every zone' },
        scope: { type: 'string', description: 'Namespace prefix, e.g. company/platform' },
      },
      required: ['query'],
    },
  },
  {
    name: 'kns.get',
    description: 'Read a bounded excerpt from a document in a named zone.',
    inputSchema: {
      type: 'object',
      properties: {
        zone: { type: 'string', description: 'Zone name from a resolve result' },
        id: { type: 'string', description: 'Document id from a resolve result' },
        from: { type: 'integer', minimum: 1, description: 'First line (default 1)' },
        lines: { type: 'integer', minimum: 1, maximum: MAX_GET_LINES, description: 'Lines to read' },
      },
      required: ['zone', 'id'],
    },
  },
  {
    name: 'kns.answer',
    description: 'Resolve a query and return cited evidence: snippets with their zone, owner, and age.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        k: { type: 'integer', minimum: 1, maximum: 20 },
        scope: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'kns.zones',
    description: 'List the zones this machine knows about, with tier, distance, and owner.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'kns.status',
    description: 'Report registry and cache status.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const;

/** Wrap a payload as an MCP content block. */
function toolResult(payload: unknown): { content: { type: 'text'; text: string }[]; isError: false } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
}

/** Wrap an error as a failed MCP tool result. */
function toolError(error: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  const knsError = error instanceof KnsError ? error : null;
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    error: {
      code: knsError?.code ?? 'internal',
      message: error instanceof Error ? error.message : String(error),
      nextStep: knsError?.nextStep ?? null,
    },
  };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true };
}

/** Read a bounded integer argument. */
function readBounded(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new KnsError('invalid_request', `${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/**
 * Execute one tool call.
 *
 * @param name - Tool name.
 * @param args - Tool arguments, untrusted.
 * @param deps - Ambient inputs.
 * @returns The tool payload.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  deps: ServerDeps,
): Promise<unknown> {
  if (name === 'kns.resolve' || name === 'kns.answer') {
    const candidate: Record<string, unknown> = { query: args['query'], scope: args['scope'] ?? null };
    if (args['k'] !== undefined) candidate['k'] = args['k'];
    if (name === 'kns.resolve' && args['mode'] !== undefined) candidate['mode'] = args['mode'];

    const parsed = parseResolveRequest(candidate);
    if (!parsed.ok) throw issuesToError(parsed.issues);

    const options: Parameters<typeof resolve>[1] = {
      registry: await deps.loadRegistry(),
      config: await deps.loadConfig(),
      createClient: deps.createClient,
    };
    if (deps.cache !== undefined) options.cache = deps.cache;

    const result = await resolve(parsed.value, options);
    if (name === 'kns.resolve') return { schemaVersion: SCHEMA_VERSION, ...result };

    return {
      schemaVersion: SCHEMA_VERSION,
      query: parsed.value.query,
      evidence: result.hits.map((hit) => ({
        documentId: hit.documentId,
        zone: hit.provenance.zone,
        tier: hit.provenance.tier,
        owner: hit.provenance.owner,
        ageDays: hit.provenance.ageDays,
        conflict: hit.conflict,
        text: hit.snippet,
      })),
      partial: result.partial,
      warnings: result.warnings,
    };
  }

  if (name === 'kns.get') {
    const zoneName = args['zone'];
    const documentId = args['id'];
    if (typeof zoneName !== 'string' || typeof documentId !== 'string') {
      throw new KnsError('invalid_request', 'zone and id are required strings');
    }

    const registry = await deps.loadRegistry();
    const zone = findZone(registry, zoneName);
    if (zone === null) {
      throw new KnsError('invalid_request', `no zone named "${zoneName}"`, 'call kns.zones');
    }

    const from = readBounded(args['from'], 1, 1, 5000, 'from');
    const lines = readBounded(args['lines'], 40, 1, MAX_GET_LINES, 'lines');
    const config = await deps.loadConfig();
    const client = deps.createClient(zone);

    try {
      const text = await client.get(documentId, from, lines, config.resolution.zoneDeadlineMs);
      return { schemaVersion: SCHEMA_VERSION, zone: zoneName, documentId, from, lines, text };
    } finally {
      await client.close();
    }
  }

  if (name === 'kns.zones') {
    const registry = await deps.loadRegistry();
    return {
      schemaVersion: SCHEMA_VERSION,
      zones: registry.zones.map((zone) => ({
        name: zone.name,
        namespace: zone.namespace,
        tier: zone.tier,
        distance: zone.distance,
        owner: zone.owner,
        ttlSeconds: zone.ttlSeconds,
      })),
    };
  }

  if (name === 'kns.status') {
    const registry = await deps.loadRegistry();
    return {
      schemaVersion: SCHEMA_VERSION,
      zones: registry.zones.length,
      cache: deps.cache?.stats() ?? null,
    };
  }

  throw new KnsError('invalid_request', `unknown tool "${name}"`, 'call tools/list');
}

/**
 * Handle one JSON-RPC message.
 *
 * @param message - Decoded request.
 * @param deps - Ambient inputs.
 * @returns The response, or null for a notification.
 */
export async function handleMessage(
  message: Record<string, unknown>,
  deps: ServerDeps,
): Promise<JsonRpcResponse | null> {
  const method = message['method'];
  const rawId = message['id'];
  const id = typeof rawId === 'number' || typeof rawId === 'string' ? rawId : null;

  if (typeof method !== 'string') {
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'invalid request' } };
  }
  if (method.startsWith('notifications/')) return null;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: { name: 'kns', version: '0.0.0' },
        capabilities: { tools: {} },
      },
    };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }

  if (method === 'tools/call') {
    const params = (message['params'] ?? {}) as Record<string, unknown>;
    const name = params['name'];
    const args = (params['arguments'] ?? {}) as Record<string, unknown>;

    if (typeof name !== 'string') {
      return { jsonrpc: '2.0', id, result: toolError(new KnsError('invalid_request', 'tool name is required')) };
    }

    try {
      return { jsonrpc: '2.0', id, result: toolResult(await callTool(name, args, deps)) };
    } catch (error) {
      // Tool failures are reported in-band with isError so the caller can react,
      // rather than as transport errors that look like the server broke.
      return { jsonrpc: '2.0', id, result: toolError(error) };
    }
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method "${method}"` } };
}

/**
 * Serve MCP over a pair of streams.
 *
 * @param input - Stream carrying requests.
 * @param output - Stream to write responses to.
 * @param deps - Ambient inputs.
 */
export function serve(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  deps: ServerDeps,
): void {
  const framer = new MessageFramer();
  let queue: Promise<unknown> = Promise.resolve();

  input.on('data', (chunk: Buffer) => {
    let bodies: string[];
    try {
      bodies = framer.push(chunk);
    } catch {
      output.write(encodeMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'message too large' } }));
      return;
    }

    for (const body of bodies) {
      queue = queue.then(async () => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(body) as Record<string, unknown>;
        } catch {
          output.write(encodeMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
          return;
        }

        const response = await handleMessage(message, deps).catch((error: unknown) => ({
          jsonrpc: '2.0' as const,
          id: null,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
        }));
        if (response !== null) output.write(encodeMessage(response));
      });
    }
  });
}
