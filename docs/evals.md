# Evaluation

**Status:** skeleton. The harness lands in PR-11 and this document then carries
committed baseline numbers, refreshed by any PR that changes ranking or resolution.

Ranking weights and early-exit thresholds are not tunable by intuition. Until the
harness exists, the defaults in [configuration](configuration.md) are deliberately
conservative — they fan out more than necessary and let ranking decide.

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
npm run bench:tiers        # lands with PR-11
```

Results are written as JSON and as a Markdown readout, and the readout is committed.
A benchmark whose numbers live only in someone's terminal cannot catch a regression.

## Baseline

_No numbers yet — the harness does not exist. PR-11 fills this table and every
subsequent ranking change updates it in the same PR._
