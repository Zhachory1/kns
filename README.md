# KNS — Knowledge Name System

Hierarchical retrieval-augmented generation with DNS-like resolution.

Every person keeps a **local, private RAG** over their own documents. Knowledge that
turns out to be useful beyond one person is **promoted** into a shared zone (team,
then company) through an explicit, auditable, reversible step. An agent resolves a
query by walking the hierarchy: nearest zone first, falling back outward until it
finds an authoritative answer.

Local retrieval stays private and fast. Shared knowledge becomes discoverable without
copying everything everywhere.

## Status

**Implementation in progress.** Milestone M0 (scaffold, CI, coverage floor, docs gate,
core domain types) has landed on `main`. The remaining milestones (M1–M4) land
one pull request at a time via the release train; see `ROADMAP.md` for status.

Start here:

- [`DESIGN.md`](DESIGN.md) — architecture, resolution algorithm, ranking, promotion,
  privacy, quality gates
- [`ROADMAP.md`](ROADMAP.md) — milestones M0–M4
- [`docs/setup-guide.md`](docs/setup-guide.md) — planned setup for new teams and companies
- [`docs/plan-prs.md`](docs/plan-prs.md) — the 20 PRs that build it
- [`docs/documentation-policy.md`](docs/documentation-policy.md) — documentation
  coverage rules

## The idea in one picture

```
                         Agent (MCP client)
                              │  kns.resolve
                              ▼
                   ┌───────────────────────┐
                   │  kns-mcp / resolver   │  walk zones, merge, rank
                   └──────────┬────────────┘
             ask nearest first│ fall back outward
        ┌─────────────┬───────┴────────┬──────────────┐
        ▼             ▼                ▼              ▼
      USER          TEAM            COMPANY        TTL cache
    (private)     (team ACL)      (all-hands)    (remote hits)
```

The DNS analogy is load-bearing, not decorative:

| DNS | KNS |
|-----|-----|
| Resolver you ask first | Local user index |
| Recursive fallback up the tree | team → company zones |
| Authoritative nameserver | The zone that owns the canonical answer |
| TTL / cache | Chunk freshness + local cache of remote hits |
| Zone delegation | A team owns a namespace of knowledge |
| Root servers | Company-wide index (last resort) |
| Root hints file | `zones.json` registry |

The borrowed property that matters: **the caller does not need to know which tier
holds the answer.** The resolver walks the tree and returns the most authoritative
hit.

## What this project is not

It is not a new vector database. Each zone is an existing local RAG stack — by
default [ZBrain](https://github.com/Zhachory1/ZBrain) (Node 22, SQLite/FTS5, local
embeddings, stdio MCP server) — pointed at a different corpus. A shared zone is just
a git repository of Markdown; access control is repository access.

The only genuinely new components are the resolver/router and the promotion workflow.

## Planned surface

Once M1–M4 land:

```bash
kns zone add --name team-platform --namespace company/platform --tier TEAM \
             --root ~/zones/team-platform
kns zone sync                       # git pull + reindex each shared zone

kns resolve "how do we handle index reloads?" --json
kns resolve "..." --scope company/platform --explain

kns promote suggest                 # candidates, with reasons; writes nothing
kns promote draft <docId> --to team-platform   # sanitized draft + provenance
kns promote publish --confirm       # opens a PR; never pushes to a default branch

kns-mcp                             # drop-in replacement for zbrain-mcp
```

Promotion always requires a human. Secrets are a hard failure, not a warning, and
publishing goes through a pull request so the review and the audit trail come for
free.

## Quality bar

Both gates are enforced in CI and block merges from the first PR onward:

- **Test coverage ≥ 80%** — lines, branches, functions, and statements
  (`node --test` + `c8`). The threshold ratchets up, never down.
- **Documentation coverage 100% of the public surface** — every exported symbol,
  CLI command and flag, MCP tool, and config key is documented, verified by
  `npm run docs:check`. Contract docs are generated from code and diffed in CI, so
  documentation drift is a failing build rather than a TODO.

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Origin

Distilled from a personal design note on hierarchical RAG and DNS-style resolution.
This repository is the public, generic version: no employer-specific content, names,
or examples.

## License

MIT — see [`LICENSE`](LICENSE).
