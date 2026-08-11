# Evaluation

**Status:** implemented (PR-11). The numbers below are committed and must be refreshed
by any pull request that changes ranking or resolution.

Ranking weights and early-exit thresholds are not tunable by intuition, so this
measures them. Each zone is served by a deterministic in-process engine, which keeps
the numbers about the router rather than about whichever backend happens to be
installed.

## Fixtures

A synthetic three-zone corpus in which the correct authority for every query is known
by construction. The interesting cases are adversarial:

| Case | What it tests |
|------|---------------|
| Stale company document versus fresh team document | Freshness beats nearness-to-root |
| Weak local note versus strong company document | Nearness is a prior, not an override |
| Same document promoted into two zones | Deduplication and `alsoIn` |
| Private-only document | It must never appear in shared-zone output |
| Query answerable at every tier | Early exit stops at distance 0 |

## Metrics

| Metric | Meaning | Guard |
|--------|---------|-------|
| `recall@k` | The right chunk surfaced at all | Must not regress against the USER-only baseline |
| `authority@1` | Top hit came from the correct authority zone | Primary quality metric |
| `fanoutRate` | Share of queries that left distance 0 | Cost proxy |
| `p95ResolveMs` | Latency | USER-only p95 plus a stated budget |
| `leakCount` | Private fixture content appearing in shared output | **Must be 0** |

`leakCount` is a release gate rather than a metric to watch trend. A non-zero value
blocks the release.

## Running

```bash
npm run bench:tiers
```

Results are written as JSON and as a Markdown readout, and the readout is committed.
A benchmark whose numbers live only in someone's terminal cannot catch a regression.

## Baseline

| Metric | Hierarchy | USER-only baseline |
|--------|-----------|--------------------|
| `recall@k` | 100% | 20% |
| `authority@1` | 100% | 20% |
| `fanoutRate` | 80% | 0% |
| `p95ResolveMs` | 1 | 0 |
| `leakCount` | 0 | 0 |

| Case | Top hit | Zone | Authoritative | Early exit |
|------|---------|------|---------------|------------|
| local answer, fresh and unambiguous | `notes/laptop-setup.md` | user | yes | distance 0 |
| stale company versus fresh team | `runbooks/index-reload-current.md` | team | yes | distance 1 |
| weak local versus strong company | `policy/data-retention.md` | company | yes | distance 2 |
| same document promoted into two zones | `concepts/hot-index-reload.md` | team | yes | distance 1 |
| owned and current beats unowned and archived | `runbooks/oncall.md` | team | yes | distance 1 |

The USER-only column is the honest comparison: the private zone alone answers one of
the five cases, because four of them are questions whose authoritative answer lives on
a team or the company. That is the whole reason the hierarchy exists.

`fanoutRate` of 80% is the early-exit path working on exactly the case it should — the
clear, fresh, local answer — and declining to stop on the four cases where the local
zone does not hold the answer.

## What the harness changed

Two defaults were wrong when first measured, and both were caught here rather than by
inspection:

1. **`rrfK` 60 → 10.** At 60, adjacent ranks differ so little that the nearness prior
   decided every comparison. See [ranking](ranking.md).
2. **A coverage factor was added.** Reciprocal Rank Fusion assumes every ranker ranks
   the *same* corpus. Zones do not — their corpora are disjoint — so "rank 1 in the
   local zone" and "rank 1 in the company zone" are not comparable, and a zone holding
   one weak match tied with the zone holding the exact answer. `authority@1` was 60%.
   Adding an engine-independent coverage factor, computed by KNS from the returned
   snippet rather than from any engine's score, took it to 100%.

The second is a real limitation of the design as originally written, not a tuning
detail. It is recorded here because the reasoning matters more than the number.
