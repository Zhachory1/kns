# Zones

**Status:** skeleton. Registry management lands in PR-03, delegation in PR-19.

A zone is one addressable corpus, one index, and one access control list. Everything
else in KNS is routing between zones.

| Tier | Corpus | Access | Cached |
|------|--------|--------|--------|
| `USER` | Your own notes, on your machine | You | Never — already local |
| `TEAM` | A team's promoted knowledge | Team membership | Yes, per `ttlSeconds` |
| `COMPANY` | Org-wide promoted knowledge | All-hands | Yes, per `ttlSeconds` |

## A shared zone is a git repository

There is no zone server. A shared zone is a repository of Markdown that you clone, and
`kns zone sync` runs `git pull` followed by a reindex. Three consequences, all of them
the point:

- **Access control is repository access.** No new permission system to build, audit,
  or get wrong.
- **History is the audit trail.** Who promoted what, when, and what a reviewer said.
- **Revert is demotion.** Reverting the pull request removes the knowledge from the
  zone at the next sync.

It also means a query never crosses the network. The resolver talks to local
processes over stdio; freshness arrives by `git pull` on your schedule.

## Adding a zone

```bash
git clone git@github.com:org/team-platform-docs.git ~/zones/team-platform
kns zone add --name team-platform \
             --namespace company/platform \
             --tier TEAM --distance 1 \
             --root ~/zones/team-platform
kns zone sync
```

`kns zone add` validates the entry and writes it to `~/.kns/zones.json`. A malformed
registry fails closed: no zone loads, and the error names the offending entry. A
half-loaded registry would silently change which zone is authoritative, which is worse
than not answering.

## What a zone engine must provide

KNS spawns `transport.command` and speaks MCP over stdio to it. An engine qualifies if
it answers `initialize` and then `tools/call` for a search tool, returning results in a
content block. Both message framings are accepted — `Content-Length` headers and
newline-delimited JSON — because both exist in the wild.

Field naming is treated leniently: a hit may spell its identifier `documentId`, `id`,
or `path`, and its excerpt `snippet`, `excerpt`, `text`, or `body`. Anything missing
becomes null rather than an error. A zone is a trust boundary, so one engine's odd
payload must not fail a query the other zones can answer.

Each zone gets one child process, spawned on first use and reused. A call that exceeds
its deadline reclaims the process — SIGTERM escalating to SIGKILL — so the next query
starts from a known state instead of queueing behind a hung call.

## Delegation

Namespaces form a tree, exactly like DNS zones:

```
company
└── company/platform
    └── company/platform/search-ranking
```

`--scope company/platform` restricts a query to that subtree. Delegation is also how a
zone that outgrows the per-zone corpus limits gets sharded: split it into sub-zones,
each with its own index and its own owner.

Cycles are rejected at load time and delegation depth is capped.
