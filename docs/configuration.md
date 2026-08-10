# Configuration

**Status:** skeleton. Keys are added by the PR that reads them; the registry keys land
with PR-03 and the ranking keys with PR-06. From PR-20 this document is generated from
the config schema and diffed in CI.

Configuration lives in `~/.kns/` (override with `KNS_HOME`). Nothing is fetched over
the network: the registry is a local file that you edit or that `kns zone add` edits
for you.

| File | Contents |
|------|----------|
| `zones.json` | Zone registry — the "root hints" of the DNS analogy |
| `config.json` | Resolution, ranking, and cache settings |
| `cache.sqlite` | TTL cache and local demand counters. Sensitive local data |

## Zone entry

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `name` | string | — | Unique zone identifier |
| `namespace` | string | — | Dotted-path namespace, e.g. `company/platform` |
| `tier` | `USER\|TEAM\|COMPANY` | — | Label; routing uses `distance` |
| `distance` | integer ≥ 0 | — | 0 is nearest. Zones may share a distance |
| `transport.kind` | `stdio` | — | Only `stdio` is supported in 0.1.0 |
| `transport.command` | string | — | Usually `zbrain-mcp` |
| `transport.args` | string[] | `[]` | Usually `["--root", "<path>"]` |
| `ttlSeconds` | integer ≥ 0 | `0` | Remote-hit cache TTL. `0` disables caching |
| `halfLifeDays` | number > 0 | `365` | Freshness decay half-life |
| `owner` | string | `null` | Person or group answerable for this zone |
| `sourceRepo` | string | `null` | Git remote, used by `kns zone sync` |
| `neverEarlyExit` | boolean | `false` | Force the walk to continue past this zone |

## Resolution

| Key | Default | Notes |
|-----|---------|-------|
| `k` | `10` | Hits returned |
| `zoneDeadlineMs` | `1500` | Per-zone deadline. Exceeded zones are dropped |
| `resolveDeadlineMs` | `4000` | Overall deadline |
| `maxConcurrentZones` | `4` | Cap on simultaneously spawned zone processes |

## Ranking

| Key | Default | Notes |
|-----|---------|-------|
| `rrfK` | `60` | Reciprocal Rank Fusion constant |
| `nearnessBase` | `0.9` | Prior is `nearnessBase ^ distance` |
| `unownedPenalty` | `0.85` | Applied to shared documents with no owner |
| `staleFactor` | `0.5` | Applied past `review_by` |

## Early exit

| Key | Default | Notes |
|-----|---------|-------|
| `marginMin` | `0.15` | Normalized margin of rank 1 over rank 2 |
| `authoritativeMaxAgeDays` | `90` | Older top hits do not stop the walk |
| `minHits` | `1` | Minimum hits at a distance before stopping |

Defaults are deliberately conservative: they fan out more than necessary. Real values
are chosen from the eval harness in PR-11, as recorded in [evals](evals.md).
