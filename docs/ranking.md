# Ranking

**Status:** skeleton. Fusion lands in PR-06, early exit in PR-08, conflict detection in
PR-16. Weights are chosen from the harness in PR-11.

## Why not just compare scores

Zones can run different retrieval modes. A BM25 score and a cosine similarity are not
comparable, and even two BM25 indexes over different corpora produce scores on
different scales. Comparing them directly would make ranking an artifact of corpus
size rather than relevance.

KNS therefore ranks on **rank**, not score, using Reciprocal Rank Fusion, and applies
priors on top:

```
rrf(hit)       = 1 / (rrfK + rankWithinZone)
nearness(hit)  = nearnessBase ^ zone.distance
freshness(hit) = exp(-ageDays / zone.halfLifeDays)
authority(hit) = (hit.owned ? 1 : unownedPenalty)
               * (hit.pastReviewTtl ? staleFactor : 1)

score = rrf * nearness * freshness * authority
```

Nearness is a mild prior, not an override. A fresh, owned, top-ranked company document
can and should outrank a weak local note — otherwise the hierarchy would just be a
slower version of local-only search.

### Why `rrfK` is 10, not 60

RRF's textbook constant of 60 assumes many rankers over one corpus, where the point is
to damp any single ranker's confidence. KNS has a handful of zones and the opposite
need: rank has to carry real signal.

At `rrfK = 60`, adjacent ranks differ by so little that the priors decide every
comparison. Concretely, a rank-9 local note scores `1/69 = 0.0145`, while a rank-1
fresh company document scores `1/61 × 0.9² ≈ 0.0132` — the local note wins purely on
distance. That makes nearness an override, which is exactly what this design says it
must not be.

At `rrfK = 10` the same comparison is `1/19 = 0.053` against `1/11 × 0.81 ≈ 0.073`, and
the better-ranked document wins. Rank leads; the priors adjust. This was caught by the
"nearness is a prior, not an override" property test rather than by inspection, which
is the argument for having it.

PR-11 tunes the value against the harness. Until then it is a defensible default
rather than a measured one.

Ties break on `(score desc, distance asc, documentId asc)`, so the same inputs always
produce the same output. Determinism is property-tested, not assumed.

## Early exit

The walk stops at a distance when its top hit is unambiguous, fresh, and the caller
did not ask for breadth. This is the DNS cache-hit path: it keeps the common case at
local latency and bounds fan-out cost.

Escape hatches: `--no-early-exit`, `mode: "broad"`, and `neverEarlyExit` on a zone.
Every response reports `earlyExitAt` and `zonesQueried`, so the behavior is
observable rather than a hidden optimization.

## Conflict

Two zones can disagree — typically a stale company document against a fresher team
one. Freshness and authority already push the fresher, owned document up. Conflict
detection makes that visible: hits sharing promotion lineage but differing in content
are marked `conflict: true` with a pointer to the other zone, and `kns resolve
--explain` prints which factor decided the order.

Surfacing the disagreement matters more than silently winning it. The reader is the
one who can tell which document is actually right, and who to ask.
