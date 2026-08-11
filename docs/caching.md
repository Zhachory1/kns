# Caching

**Status:** skeleton. The cache lands in PR-09.

Remote zone hits are cached locally so that cross-zone latency stays off the hot path.
This is the TTL half of the DNS analogy, and it behaves the same way: serve from cache
until the entry expires or the source version changes.

## Key and invalidation

The cache key is `(zoneName, chunkId, sourceVersion)`, where `sourceVersion` combines
the zone's index generation with the document hash reported by the zone's `status`
call.

Two invalidation paths, both required:

- **TTL expiry** — bounded staleness even if a zone never reports a version change.
- **Version bump** — a reindexed document invalidates immediately, without waiting out
  the TTL.

The `USER` tier is never cached. It is already local, and caching it would only add a
way for local retrieval to serve something stale.

## What is stored

Snippets and metadata only, under the same bounds the MCP tools enforce. The cache is
not a mirror of a shared zone; a zone's full contents arrive through `git pull`, not
through query traffic.

`~/.kns/cache.sqlite` is sensitive local data. It contains excerpts from zones you can
read, it is gitignored, and `kns cache purge` removes it. Treat it the way you would
treat a local search index.

## Size

The cache has a size cap with least-recently-used eviction. `kns cache stats` reports
entry count, size, hit rate, and per-zone breakdown — the hit rate is also the honest
answer to "is the fan-out actually expensive", which the eval harness measures as
`fanoutRate`.

A corrupt cache is rebuilt rather than fatal: a caching layer must never be able to
take down retrieval.
