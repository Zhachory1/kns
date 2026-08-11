# ADR 0001: Reuse ZBrain as the per-zone engine

**Status:** accepted (0.1.0)

## Context

Every zone needs an index and a retrieval engine. The obvious alternatives were to
build one, to run a shared vector database, or to reuse the local-first stack that
already exists and is already trusted with private notes.

A shared vector cluster would also need an access-control model, an operator, and a
budget. None of those exist for a personal project, and inventing an ACL system was
explicitly a non-goal.

## Decision

Each zone is a ZBrain instance pointed at a different corpus, reached over stdio MCP.
KNS contributes only the resolver and the promotion workflow.

## Consequences

Zero new infrastructure: a shared zone is a git repository of Markdown, and access
control is repository access. Provenance, audit, review, and revert all come from git
rather than from code this project would have to write and secure.

The cost is a corpus ceiling — ZBrain's caps of roughly 20k documents and 100MB per
zone. Delegation (ADR 0003's sibling, implemented in PR-19) is the escape hatch:
shard a zone into sub-zones, each with its own index and owner.

Reversing this would mean writing an adapter for a different engine. The `ZoneClient`
interface is the seam, and it is deliberately small — search, get, status, close — so
the reversal is bounded.

## Alternatives rejected

- **Qdrant or pgvector cluster.** Infrastructure to run and an ACL model to invent,
  for a scale nothing here has reached. Revisit only when a zone exceeds the caps.
- **One flat company index.** That is the problem this design exists to solve, not a
  solution to it.
- **Writing a new engine.** Retrieval quality is not where this project's novelty is.
