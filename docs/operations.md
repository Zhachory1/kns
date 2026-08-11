# Operations

**Status:** skeleton. Runbooks are added by the PRs that create the failure modes they
describe: degraded zones in PR-07, cache in PR-09, review sweeps in PR-18.

KNS runs on a laptop, so "operations" here means: what to do when a query returns
something surprising.

## A result came back marked partial

A zone failed or exceeded its deadline. The warnings name it.

```bash
kns resolve "..." --json | grep -A3 warnings
kns zone show <name>
```

This is expected behavior, not an outage: a zone that is unavailable degrades the
result and never fails the query. If it persists, the zone's clone or its index is
usually the cause — try `kns zone sync`.

## Results look stale

Shared zones are as fresh as your last sync, by design. Run `kns zone sync`. If a
document changed but the old text still appears, the TTL cache is serving it; a
version bump normally invalidates it, so a stale hit past a sync is a bug worth
reporting. `kns cache purge --zone <name>` unblocks you in the meantime.

## Resolution feels slow

Check `resolveMs` and `earlyExitAt` in the JSON envelope. A `null` early exit on
common queries means the walk is fanning out every time — either the thresholds are
too strict for your corpus or the local zone genuinely lacks the answer. The eval
harness reports `fanoutRate` across a whole query set, which is the honest version of
this measurement.

## A promotion was refused

The sanitizer blocked it, exit code 2, and the finding says which rule fired. This is
working as intended. Remove the secret from the source note — not from the draft —
and try again. There is no override flag, and adding one would defeat the gate.

## Shared zone quality is drifting

```bash
kns review --zone <name>
```

Lists documents past their review date or without an owner, and opens renewals or
demotions. Ranking already penalizes them, so this is maintenance rather than an
emergency — but a shared zone nobody prunes eventually retrieves worse than a local
one, which is the failure this whole system exists to avoid.
