# CLI contract

**Status:** skeleton. Commands are added here by the PR that implements them; the
first real entries land with PR-03 (`kns zone`). From PR-20 this document is
generated from the command registry and diffed in CI, so it cannot drift from the
code.

## Principles

- Every command supports `--json`. Machine-readable output is the contract; the human
  rendering is a convenience layer over the same data.
- Every JSON payload carries `schemaVersion`.
- Read commands never write. `kns promote suggest` writes nothing at all.
- Commands that cross a privacy or repository boundary require an explicit
  confirmation flag. There is no implicit publish.

## Envelope

Success:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "result": {}
}
```

Failure:

```json
{
  "schemaVersion": 1,
  "ok": false,
  "error": {
    "code": "invalid_request",
    "message": "query is required",
    "retryable": false,
    "nextStep": "pass a query argument"
  }
}
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success, including a partial result where some zones were unavailable |
| 1 | Request error: bad arguments, invalid registry, unknown zone |
| 2 | Refused: the sanitizer blocked a promotion, or a confirmation flag was missing |
| 3 | Internal error |

A degraded result is a success. A zone that times out produces exit code 0, a
populated result, and a warning — never a failure.

## Planned commands

| Command | Lands in | Purpose |
|---------|----------|---------|
| `kns zone list\|add\|remove\|show` | PR-03 | Manage the zone registry |
| `kns resolve <query>` | PR-05 | Resolve a query across the hierarchy |
| `kns cache stats\|purge` | PR-09 | Inspect and clear the TTL cache |
| `kns promote suggest` | PR-12 | List promotion candidates with reasons |
| `kns promote draft` | PR-14 | Write a sanitized draft into a zone worktree |
| `kns promote publish\|revoke` | PR-15 | Open a pull request, or undo a promotion |
| `kns review` | PR-18 | Find past-TTL and unowned promoted documents |
| `kns signal stats\|export` | PR-17 | Local demand counters, opt-in export |
