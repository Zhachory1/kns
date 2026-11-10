# ADR 0003: Shared zones sync over git, not a query transport

**Status:** accepted (0.1.0)

## Context

A shared zone has to reach a user's machine somehow. The two options were a network
query API — the resolver asks a remote zone service per query — or distribution: the
zone is a repository, cloned and reindexed locally.

## Decision

Shared zones are git repositories of Markdown. `kns zone sync` pulls and reindexes.
The resolver only ever talks to local processes over stdio. There is no remote query
transport in 0.1.0.

## Consequences

Queries never leave the machine. That is a privacy property that no amount of
transport-layer care can match, and it removes an entire class of question about what
a zone service logs.

Authentication is git authentication, which the user already has and already trusts.
No tokens to issue, rotate, or leak.

Freshness becomes a pull, not a push: a zone is as current as the last sync. For
knowledge that is promoted deliberately and reviewed on a six-month cycle, that is an
acceptable trade — and the TTL cache exists precisely because the alternative was
worse.

Scale is bounded by what a laptop can index. Delegation shards a zone that outgrows
it.

Reversing this means adding an `http` transport kind. The registry schema already
discriminates on `transport.kind` and rejects unknown kinds, so the seam exists; the
work would be authentication and the threat model, not plumbing.

## Alternatives rejected

- **HTTP query API per zone.** A service to operate, authenticate, and monitor, plus
  a new place where queries could be logged.
- **A single shared index everyone queries.** The flat-sharing failure this whole
  design starts from.
