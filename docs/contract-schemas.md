# Schema contract

**Status:** current as of PR-02. Types live in `src/core/types.ts`; validation lives in
`src/core/validate.ts`. From PR-20 the tables below are generated from the types and
diffed in CI.

Every envelope carries `schemaVersion`. It moves only when a wire shape changes,
independently of the package version.

## Validation posture

Two inputs are untrusted and are parsed rather than cast: the zone registry on disk,
and requests from a CLI user or MCP client.

- **Unknown fields are rejected.** A typo in a registry entry would otherwise fall back
  to a default and quietly change which zone is authoritative.
- **Out-of-range values are rejected, not clamped.** A caller never silently receives
  something other than what it asked for.
- **Every issue is reported with a dotted path**, so a bad registry names the field.

## Tier

`USER`, `TEAM`, or `COMPANY`. Ordering uses `distance`; the tier is a label.

## Zone

| Field | Type | Default |
|-------|------|---------|
| `name` | non-empty string | required |
| `namespace` | non-empty string | required |
| `tier` | `USER\|TEAM\|COMPANY` | required |
| `distance` | integer 0–64 | required |
| `transport` | `Transport` | required |
| `ttlSeconds` | integer 0–31536000 | `0` |
| `halfLifeDays` | number 0.5–36500 | `365` |
| `owner` | string or null | `null` |
| `sourceRepo` | string or null | `null` |
| `neverEarlyExit` | boolean | `false` |

`Transport` is `{ kind: "stdio", command: string, args: string[] }`. `args` defaults to
`[]`. Only `stdio` is accepted in 0.1.0; an unknown kind fails closed.

## ResolveRequest

| Field | Type | Default |
|-------|------|---------|
| `query` | non-empty string, ≤ 1000 characters | required |
| `k` | integer 1–20 | `10` |
| `mode` | `exact\|broad` | `exact` |
| `scope` | namespace prefix or null | `null` |
| `noEarlyExit` | boolean | `false` |

## Hit

```json
{
  "documentId": "concepts/hot-index-reload.md",
  "snippet": "...",
  "rankWithinZone": 1,
  "score": 0.0161,
  "provenance": {
    "zone": "team-platform",
    "namespace": "company/platform",
    "tier": "TEAM",
    "distance": 1,
    "owner": "platform-team",
    "ageDays": 12,
    "pastReviewTtl": false
  },
  "alsoIn": [],
  "conflict": false
}
```

`score` is the fused score described in [ranking](ranking.md): comparable between hits
within one response, meaningless across responses. Provenance is nested rather than
flattened so that a hit can be forwarded without losing the context that makes it
judgeable.

## Envelopes

```json
{ "schemaVersion": 1, "ok": true, "result": {} }
```

```json
{
  "schemaVersion": 1,
  "ok": false,
  "error": {
    "code": "invalid_request",
    "message": "validation failed — request.k: expected a value between 1 and 20",
    "retryable": false,
    "nextStep": "correct the reported fields"
  }
}
```

A `ResolveResult` payload contains `hits`, `zonesQueried`, `earlyExitAt`, `partial`,
`resolveMs`, and `warnings`. `earlyExitAt` is the distance at which the walk stopped,
or `null` when every zone was queried. `partial` is true when any zone failed or timed
out, and the warnings say which.

## Error codes

| Code | Meaning | Retryable |
|------|---------|-----------|
| `invalid_request` | Caller error: bad argument, out-of-range bound | No |
| `registry_invalid` | The zone registry failed to parse or validate | No |
| `zone_unavailable` | A zone could not be reached or started | Yes |
| `zone_timeout` | A zone exceeded its deadline | Yes |
| `sanitizer_blocked` | A promotion was refused by the gate | No |
| `internal` | Unexpected failure | No |

Retryability is a property of the code, not a judgement the caller has to make.
Anything thrown that is not a `KnsError` becomes `internal`, so error handling is
total and no stack trace reaches the wire.
