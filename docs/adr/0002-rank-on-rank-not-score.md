# ADR 0002: Rank on rank, with a coverage correction

**Status:** accepted (0.1.0)

## Context

Zones may run different engines. A BM25 score and a cosine similarity live on
different scales, and even two BM25 indexes over different corpora disagree, so
comparing raw scores would make ranking an artifact of corpus size.

## Decision

Fuse on rank using Reciprocal Rank Fusion, then apply priors KNS can justify:
nearness, freshness, and authority. Add a **coverage** factor — the fraction of query
terms present in the returned snippet — computed by KNS itself, identically for every
zone.

## Consequences

No per-backend calibration is needed, and adding a zone that runs a different engine
requires no tuning.

The coverage factor exists because RRF alone was measurably wrong here. RRF assumes
every ranker ranks the *same* corpus; zones do not, so "rank 1 in the local zone" and
"rank 1 in the company zone" are not comparable claims, and a zone holding one weak
match tied with the zone holding the exact answer. The eval harness scored
`authority@1` at 60% before coverage and 100% after.

Coverage is lexical, so it under-credits a paraphrase. The floor keeps that from
zeroing a hit out, and the harness is where any replacement would have to prove
itself.

`rrfK` is 10 rather than the textbook 60 for a related reason: with few zones, a
constant that flat lets the nearness prior decide every comparison, which would make
nearness an override rather than a prior.

## Alternatives rejected

- **Normalising engine scores.** Requires knowing each engine's distribution, which
  is exactly the coupling this design avoids.
- **Trusting the nearest zone that answers.** Turns the hierarchy into a slower
  local-only search.
