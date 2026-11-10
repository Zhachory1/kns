# Setup guide for teams and companies

**Status:** design-stage. No runtime code exists yet; the commands below describe the
planned 0.1.0 surface that lands across milestones M1–M4 (see [ROADMAP.md](../ROADMAP.md)).
Today only the design and the documentation gate are real. Treat this as the target
setup a new team or company will follow once the resolver and promotion workflow ship.

This guide is task-oriented. For the why behind each step, read [DESIGN.md](../DESIGN.md),
[zones.md](zones.md), [promotion.md](promotion.md), and [privacy.md](privacy.md).

## Mental model

Three zone tiers. Each tier is an independent local RAG (by default `zbrain-mcp`)
pointed at a different corpus. KNS only adds routing and a promotion workflow on top.

| Tier | Corpus | Access is | Cached |
|------|--------|-----------|--------|
| `USER` | your own notes, on your machine | you | never — already local |
| `TEAM` | a team's promoted knowledge | team git-repo membership | yes, per TTL |
| `COMPANY` | org-wide promoted knowledge | all-hands git-repo membership | yes, per TTL |

A shared zone is a git repository of Markdown. There is no zone server. Access control
is repository access, the audit trail is git history, and demotion is reverting a pull
request. A query never crosses the network: the resolver talks to local processes over
stdio, and freshness arrives when you run `kns zone sync` (a `git pull` plus reindex).

## Prerequisites

- Node.js >= 22.18
- `sqlite3` with FTS5 (the same prerequisite as ZBrain)
- `git`, and the `gh` CLI (promotion publishes via a pull request)
- A per-user local RAG already running — `zbrain-mcp` over your own documents

Nothing here fetches or runs remote code during install. There is no post-install hook
and no bootstrap script; if setup ever asks you to pipe a script into a shell, that is
a bug, not a step. State lives in `~/.kns/` (override with `KNS_HOME`); see
[configuration.md](configuration.md).

## Part 1 — Every individual (USER tier)

Each person does this once. This is the local-first base — nothing is shared yet.

```bash
# install KNS (planned distribution), or run from source with `npm install`
npm install -g kns

# register your local zone; distance 0 means nearest
kns zone add --name me --namespace user --tier USER --distance 0 \
             --root ~/private-docs
```

Point your agent at the whole hierarchy by swapping one MCP server. This is a drop-in
replacement for a single-zone `zbrain-mcp`; see [contract-mcp.md](contract-mcp.md).

```json
{ "mcpServers": { "kns": { "command": "kns-mcp" } } }
```

Verify — this should return the same documents as `zbrain search`, plus provenance
(tier, zone, owner, age):

```bash
kns resolve "how do we handle index reloads?" --json
```

## Part 2 — A new team (TEAM tier)

### Team lead: create the shared zone, once

Create an empty git repository of Markdown, e.g. `github.com/org/team-platform-docs`.
That repository *is* the zone. Decide and document up front:

- **namespace** — a dotted path such as `company/platform`, which forms a DNS-like tree
- **owner** — the person or group answerable for the zone
- **review TTL** — when promoted documents must be reviewed again

### Every team member: add the zone

```bash
git clone git@github.com:org/team-platform-docs.git ~/zones/team-platform

kns zone add --name team-platform \
             --namespace company/platform \
             --tier TEAM --distance 1 \
             --root ~/zones/team-platform \
             --owner platform-team \
             --source-repo git@github.com:org/team-platform-docs.git \
             --ttl-seconds 3600

kns zone sync
```

`kns zone add` validates the entry and writes it to `~/.kns/zones.json`. A malformed
registry fails closed: no zone loads, and the error names the offending entry. See
[zones.md](zones.md) for the full registry model.

### Populate the zone by promotion

Promotion is the only path by which anything leaves the USER tier, and it always has a
human in it. See [promotion.md](promotion.md).

```bash
kns promote suggest                                  # ranked candidates with reasons; writes nothing
kns promote draft concepts/hot-index-reload.md --to team-platform
kns promote publish --confirm                        # opens a pull request
```

- The sanitizer runs on the draft and again immediately before publishing. A detected
  secret blocks the promotion; there is no override flag. Personally identifying
  information is redacted and flagged for the human to confirm. The gate fails closed.
- The draft is a curated copy with provenance frontmatter (source, promoter, owner,
  and review date), not a mirror of the private note.
- Publishing opens a pull request. It never pushes to a default branch and never
  force-pushes, so review and audit come from the repository.
- Teammates see the knowledge after the pull request merges and they run `kns zone sync`.

To fast-track a document, add `share: team` to its frontmatter; `kns promote suggest`
then treats it as a hard yes.

## Part 3 — A new company (COMPANY tier)

Same shape as a team zone, with `--tier COMPANY --distance 2` and an all-hands
repository:

```bash
git clone git@github.com:org/company-docs.git ~/zones/company

kns zone add --name company --namespace company --tier COMPANY --distance 2 \
             --root ~/zones/company --owner knowledge-ops \
             --source-repo git@github.com:org/company-docs.git --ttl-seconds 7200

kns zone sync
```

When the company zone approaches the per-zone engine limits (roughly 20k documents or
100MB for ZBrain), shard it via delegation rather than letting one index grow without
bound. Split the namespace into sub-zones, each with its own index and owner:

```
company
└── company/platform
    └── company/platform/search-ranking
```

Restrict a query to a subtree with `--scope company/platform`. Cycles are rejected at
load time and delegation depth is capped. See [zones.md](zones.md).

## What resolution does

- Walks zones nearest-first by `distance` and falls back outward until it finds an
  authoritative hit. The caller never specifies which tier holds the answer.
- Fans out in parallel within a distance group, with a per-zone deadline and an overall
  deadline (`zoneDeadlineMs`, `resolveDeadlineMs` in [configuration.md](configuration.md)).
- A dead or slow zone degrades the result and never fails the query: you get partial
  results, a warning, and exit code 0.
- Resolution is deterministic — the same inputs produce the same ranked output.

## Day-to-day operations

Full runbooks are in [operations.md](operations.md); command and exit-code contract is
in [contract-cli.md](contract-cli.md).

| Symptom | What to do |
|---------|-----------|
| Result marked `partial` | A zone failed or timed out. Run `kns zone sync`; inspect with `kns zone show <name>`. |
| Results look stale | Run `kns zone sync`. If still stale after a sync, `kns cache purge --zone <name>` and report it as a likely bug. |
| Resolution feels slow | Check `resolveMs` and `earlyExitAt` in the JSON envelope; tune thresholds or accept that the local zone lacks the answer. |
| Promotion refused (exit 2) | The sanitizer fired. Remove the secret from the source note, not the draft, and retry. There is no override. |
| Shared zone drifting | Run `kns review --zone <name>` to list past-TTL or unowned documents and open renewal or demotion pull requests. |

A shared zone that nobody prunes eventually retrieves worse than a plain local index —
the exact failure KNS exists to avoid. Run `kns review` on a schedule.

## Privacy summary to communicate org-wide

See [privacy.md](privacy.md) for the specifics.

- Everything is private by default; the USER zone never leaves the machine.
- There is exactly one exit path: promotion — a typed command, a fail-closed sanitizer,
  and a human-reviewed pull request. No automatic promotion, no background sync of
  private content, and no agent tool that can publish.
- No telemetry. Demand signals ship disabled; when enabled and exported they carry no
  query text and no user identity.

## Suggested rollout order for an organization

1. Everyone sets up the USER tier and points their agent at `kns-mcp` (Part 1).
2. One pilot team stands up a TEAM zone and promotes a handful of high-value decisions
   and concepts (Part 2).
3. Validate on real queries that hierarchical resolution beats the USER-only baseline,
   and confirm no private content leaked.
4. Add the COMPANY root, and shard it via delegation before it reaches the engine
   limits (Part 3).
