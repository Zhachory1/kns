# Schema contract

**Status:** skeleton. Types land in PR-02 and this document is completed there.

Every envelope KNS emits carries `schemaVersion`. It moves only when a wire shape
changes, independently of the package version.

## Tier

`USER`, `TEAM`, or `COMPANY`. Ordering is by `distance`, not by tier name — a tier is
a label, distance is the routing key.

## Hit

A single retrieved chunk with the provenance needed to judge it.

```json
{
  "documentId": "concepts/hot-index-reload.md",
  "zone": "team-platform",
  "namespace": "company/platform",
  "tier": "TEAM",
  "distance": 1,
  "rankWithinZone": 1,
  "score": 0.0161,
  "ageDays": 12,
  "owner": "platform-team",
  "snippet": "...",
  "conflict": false,
  "alsoIn": []
}
```

`score` is the fused score described in [ranking](ranking.md). It is comparable
between hits within one response and meaningless across responses.

## ResolveEnvelope

```json
{
  "schemaVersion": 1,
  "ok": true,
  "result": {
    "hits": [],
    "zonesQueried": ["user"],
    "earlyExitAt": 0,
    "partial": false,
    "resolveMs": 41,
    "warnings": []
  }
}
```

`earlyExitAt` is the distance at which the walk stopped, or `null` when every zone was
queried. `partial` is true when any zone failed or timed out; the warnings say which.

## Error codes

| Code | Meaning |
|------|---------|
| `invalid_request` | Caller error: bad argument, out-of-range bound |
| `registry_invalid` | The zone registry failed to parse or validate |
| `zone_unavailable` | A zone could not be reached or started |
| `zone_timeout` | A zone exceeded its deadline |
| `sanitizer_blocked` | A promotion was refused because content failed the gate |
| `internal` | Unexpected failure |

Validation rejects unknown fields rather than ignoring them, so a typo in a config or
a tool call surfaces immediately instead of being silently dropped.
