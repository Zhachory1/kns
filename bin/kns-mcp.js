#!/usr/bin/env node
/**
 * `kns-mcp` executable. All logic lives in src/mcp so it is type-checked and tested;
 * this file only binds the process streams to it.
 *
 * The zone roots come from the registry, never from a command-line flag, so there is
 * no per-invocation way to point the server at an arbitrary directory.
 */
import { HitCache, cachePath } from '../src/cache/store.ts';
import { loadConfig } from '../src/core/config.ts';
import { knsHome, loadRegistry } from '../src/core/registry.ts';
import { StdioZoneClient } from '../src/zone/client.ts';
import { serve } from '../src/mcp/server.ts';

const home = knsHome();
const cache = new HitCache(cachePath(home));

serve(process.stdin, process.stdout, {
  loadRegistry: () => loadRegistry(home),
  loadConfig: () => loadConfig(home),
  createClient: (zone) => new StdioZoneClient(zone),
  cache,
});

process.on('exit', () => cache.close());
