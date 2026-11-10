# CLI contract

**Status:** `kns zone` is implemented and documented below (PR-03). Remaining commands
are added by the PR that implements them. From PR-20 this document is generated from
the command registry and diffed in CI, so it cannot drift from the code.

## Implemented: `kns zone`

```bash
kns zone list [--scope <namespace>] [--json]
kns zone show <name> [--json]
kns zone add --name <n> --namespace <ns> --tier USER|TEAM|COMPANY \
             --distance <n> --root <path> \
             [--ttl-seconds <n>] [--half-life-days <n>] [--owner <who>] \
             [--source-repo <url>] [--never-early-exit] [--json]
kns zone remove <name> [--json]
```

`--root <path>` is the ergonomic form: it becomes `zbrain-mcp --root <absolute path>`.
`--command` and `--arg=<string>` override that for a non-ZBrain zone. A value that
itself begins with dashes must use the `=` form, because a bare `--arg --root /x`
parses as a switch followed by another flag.

## Implemented: `kns resolve`

```bash
kns resolve <query> [--k <n>] [--mode exact|broad] [--scope <namespace>] \
                    [--no-early-exit] [--json]
```

Every hit carries provenance: zone, namespace, tier, distance, owner, and age. The
envelope also reports `zonesQueried`, `earlyExitAt`, `partial`, `resolveMs`, and any
warnings.

A zone that fails or times out produces a warning and `partial: true` — **exit code
stays 0**. A degraded answer is still an answer, and the other zones may hold what the
caller needs. Only a bad request, an invalid registry, or an internal fault is a
non-zero exit.

Out-of-range values are rejected rather than clamped: `--k 99` fails instead of
quietly returning 20.

The registry lives at `$KNS_HOME/zones.json`, defaulting to `~/.kns/zones.json`. It is
only ever read from disk, never fetched, because `transport.command` names a process
to spawn.

Unknown flags are rejected rather than ignored: a silently dropped `--scope` is a wrong
answer that looks like a right one. A malformed registry loads no zones at all rather
than a subset.

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
