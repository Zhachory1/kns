# KNS — Knowledge Name System

**Hierarchical RAG with DNS-like resolution.**

Status: draft · Owner: @Zhachory1 · Created: 2026-08-10

> Prose here terse (caveman style, per author convention for design docs). Code,
> schemas, tables, thresholds exact.

---

## 1. Summary

Every user keep **local RAG** over own docs. Knowledge useful past one person get
**promoted** into shared tier (team, then company). Agent resolve query by walking
**DNS-like hierarchy** — nearest scope first, fall back outward until authoritative
answer found.

Local stay private and fast. Shared knowledge discoverable without copying
everything everywhere.

KNS is **resolver + promotion workflow only**. Not new vector DB. Each zone is an
existing RAG stack pointed at a different corpus.

---

## 2. Problem

Today each person have private semantic index (ZBrain over `~/private-docs`, or
similar local-docs-rag stack). Two failures:

1. **Siloing.** Fix, decision, concept one person captured is invisible to team and
   company. Everyone re-derive same knowledge.
2. **Flat sharing not scale.** Dump every private note into one company index →
   noise, stale drafts, half-thoughts. Precision die. Private content leak.

Want reach of shared knowledge **without** losing privacy, latency, precision of
local index.

---

## 3. Goals / Non-goals

### Goals

| # | Goal |
|---|------|
| G1 | Local-first. Private docs stay on user machine. Private by default. |
| G2 | Promotable. user → team → company. Explicit, auditable, reversible step. |
| G3 | DNS-like resolution. Query nearest zone first, fall back outward. |
| G4 | Provenance + freshness. Every hit carry tier, zone, owner, age. |
| G5 | No mass duplication. Shared zones hold promoted knowledge, not full mirrors. |
| G6 | Drop-in. Agent config swap one MCP server, get whole hierarchy. |

### Non-goals

- Not new vector DB. Reuse ZBrain (SQLite/FTS5 + local embeddings) per zone.
- Not real-time global consistency. Eventual consistency across zones fine.
- Not auto-promotion of everything. Promotion is deliberate signal + human gate.
- Not new ACL system. Lean on repo permissions / IdP groups.
- Not code retrieval. Markdown/doc corpora only (ZBrain scope).

---

## 4. DNS analogy

| DNS | KNS |
|-----|-----|
| Resolver you ask first | Local user index |
| Recursive fallback up tree | team → company zones |
| Authoritative nameserver | Zone that **owns** canonical answer |
| TTL / cache | Chunk freshness + local cache of remote hits |
| Zone delegation | Team own namespace of knowledge |
| Root servers | Company-wide index (last resort) |
| Root hints file | `zones.json` registry |

Borrowed property that matter: **caller not need know which tier hold answer.**
Resolver walk tree, return most authoritative hit.

---

## 5. Architecture

```
                         Agent (MCP client)
                              │  kns.resolve
                              ▼
                   ┌───────────────────────┐
                   │  kns-mcp / resolver   │  walk zones, merge, rank
                   ├───────────────────────┤
                   │ registry │ cache │rank│
                   └──────────┬────────────┘
             ask nearest first│ fall back outward
        ┌─────────────┬───────┴────────┬──────────────┐
        ▼             ▼                ▼              ▼
   ┌─────────┐  ┌───────────┐   ┌────────────┐  ┌──────────┐
   │  USER   │  │   TEAM    │   │  COMPANY   │  │   TTL    │
   │ zbrain  │  │  zbrain   │   │  zbrain    │  │  cache   │
   │ local   │  │  shared   │   │  shared    │  │ (sqlite) │
   └─────────┘  └───────────┘   └────────────┘  └──────────┘
   private       team ACL        all-hands       remote hits
   fast, local   (repo/IdP)      (repo/IdP)      keyed chunk+ver
```

New code = resolver, registry, ranker, cache, promotion CLI, MCP façade.
Everything else is a ZBrain instance pointed at a different root.

### 5.1 Zones (tiers)

Zone = one addressable corpus + one index + one ACL.

- **USER** — existing local index (`zbrain-mcp --root ~/private-docs`). Private.
  Fast. Authoritative for personal context.
- **TEAM** — one shared index per team. ACL = team membership. Hold knowledge
  promoted from members.
- **COMPANY** — root. Broad, curated, all-hands readable. Hold knowledge promoted
  from teams that is org-wide relevant.

Namespace addressing: `company/platform/search-ranking` resolve root → team zone →
topic. Team can delegate sub-zones (sub-team, project) same as DNS zone delegation.

### 5.2 Zone registry ("root hints")

`~/.kns/zones.json`. Answer open question "how resolver learn which zones exist".

```json
{
  "schemaVersion": 1,
  "zones": [
    {
      "name": "user",
      "namespace": "user",
      "tier": "USER",
      "distance": 0,
      "transport": { "kind": "stdio", "command": "zbrain-mcp",
                     "args": ["--root", "/Users/me/private-docs"] },
      "ttlSeconds": 0,
      "halfLifeDays": 3650,
      "owner": "me@example.com"
    },
    {
      "name": "team-platform",
      "namespace": "company/platform",
      "tier": "TEAM",
      "distance": 1,
      "transport": { "kind": "stdio", "command": "zbrain-mcp",
                     "args": ["--root", "/Users/me/zones/team-platform"] },
      "ttlSeconds": 3600,
      "halfLifeDays": 180,
      "owner": "platform-team",
      "sourceRepo": "git@github.com:org/team-platform-docs.git"
    },
    {
      "name": "company",
      "namespace": "company",
      "tier": "COMPANY",
      "distance": 2,
      "transport": { "kind": "stdio", "command": "zbrain-mcp",
                     "args": ["--root", "/Users/me/zones/company"] },
      "ttlSeconds": 86400,
      "halfLifeDays": 365,
      "owner": "eng-enablement",
      "sourceRepo": "git@github.com:org/company-docs.git"
    }
  ]
}
```

Shared zone = plain git repo of markdown. `kns zone sync` = `git pull` +
`zbrain index`. No server to operate. ACL = repo access. That is the whole
distribution story for v1.

### 5.3 Resolution algorithm

```
resolve(query, opts):
  zones   = registry.order(opts.scope)         # distance ascending
  hits    = []
  for group in zones.groupByDistance():        # same distance → parallel
      raw   = parallelSearch(group, query, k, deadlineMs)   # partial failure OK
      hits += annotate(raw, zone)              # tier, zone, owner, age, rank
      if authoritative(raw, policy): break     # DNS cache-hit path
  return rank(hits).slice(0, k)
```

Properties:

- **Nearest first.** Distance ascending. USER before TEAM before COMPANY.
- **Parallel within distance.** Two team zones at distance 1 queried concurrently.
- **Per-zone deadline.** Slow zone dropped, not block. Envelope marked `partial`.
- **Degrade, not fail.** Dead zone → warning in envelope; other zones still answer.
- **Early exit.** Strong fresh local hit → skip fan-out. Bound cost.

### 5.4 Ranking

Backends give non-comparable scores (BM25 vs cosine vs hybrid). Do **not** compare
raw scores across zones. Use **Reciprocal Rank Fusion** on per-zone rank, then apply
priors:

```
rrf(hit)       = 1 / (rrfK + rankWithinZone)          # rrfK = 60 default
nearness(hit)  = nearnessBase ^ zone.distance          # 0.9 → 1.0, 0.9, 0.81 ...
freshness(hit) = exp(-ageDays / zone.halfLifeDays)
authority(hit) = hit.owned ? 1.0 : unownedPenalty      # unowned shared = weaker
                 * (hit.pastReviewTtl ? staleFactor : 1.0)

score = rrf * nearness * freshness * authority
```

Rationale:

- RRF robust to score-scale mismatch. No per-backend calibration needed.
- Nearness is **mild prior**, not hard override. Fresh company-authoritative doc can
  beat weak local note.
- Freshness penalty on shared zones resolve conflict case: stale company doc vs
  fresh team doc → fresh team doc win.
- Deterministic tie-break: `(score desc, distance asc, documentId asc)`. Same input
  → same output. Testable.

All weights live in config. Eval harness (§7) tune them, not vibes.

### 5.5 Authoritative early-exit

Cost problem: fan-out to N zones × every query × every user. Early-exit bound it.

Exit when **all** true for top hit of current distance group:

| Condition | Default |
|-----------|---------|
| `rank == 1` and normalized margin over rank 2 | `>= marginMin` (0.15) |
| chunk age | `<= zone.authoritativeMaxAgeDays` (90) |
| hit count at this distance | `>= minHits` (1) |
| caller not request `mode: "broad"` | — |

Escape hatches: `--no-early-exit`, `mode: "broad"`, per-zone `neverEarlyExit: true`.

Metric `fanoutRate` tracked in eval — over-exit show as recall drop, under-exit as
latency and cost rise.

### 5.6 TTL cache

Remote (TEAM/COMPANY) hits cached in local SQLite.

- Key: `(zoneName, chunkId, sourceVersion)`. `sourceVersion` = zone index generation
  + doc hash from ZBrain status.
- TTL per zone (`ttlSeconds`). USER tier never cached (already local).
- On expiry or version bump → re-fetch.
- Cache store **snippet + metadata only**, same bounds as MCP output.
- `kns cache stats|purge`. Cache is sensitive local data → gitignored, documented as
  such, same class as `.zbrain/`.

---

## 6. Promotion (write path)

Crux of design. Make knowledge helpful past one user. Explicit, auditable,
reversible. **Never automatic.**

```
Local note ──suggest──▶ draft ──sanitize──▶ human approve ──▶ PR to zone repo
    │                                                              │
  private                                                      team ACL
    └──────────────── origin get promoted_to: pointer ◀────────────┘
```

### 6.1 Suggestion signals

Agent surface candidate. Human decide.

| Signal | Weight | Source |
|--------|--------|--------|
| Frontmatter `share: team` / `share: company` | hard yes | author intent |
| Doc kind = decision / concept / solution (not inbox/ephemeral) | high | frontmatter |
| Inbound link count from other docs | medium | link graph |
| Repeat retrieval by teammates' resolvers | medium | demand signal (§6.4) |
| Age past review TTL | gate (block) | frontmatter |

### 6.2 Sanitization gate

Promotion cross a privacy boundary. Gate is **hard fail**, not warning.

- Secret scan: regex families (cloud keys, VCS tokens, private-key blocks, JWTs,
  bearer tokens) + high-entropy string detector.
- PII scan: email, phone, postal-address patterns, person names drawn from local
  people pages.
- Configurable blocklist of terms (org-confidential vocabulary).
- **Any secret hit = refuse to draft.** PII hit = redact + flag for human review.
- Sanitizer run at draft time and re-run at publish time. Fail closed on both.

### 6.3 Publish

`kns promote draft <docId> --to <zone>` → sanitized copy in zone worktree with
provenance frontmatter:

```yaml
promoted_from: user/private-docs/concepts/hot-index-reload.md
promoted_by: me@example.com
promoted_at: 2026-08-10
origin_owner: me@example.com
review_by: 2027-02-10        # review TTL
canonical: true
```

- `kns promote publish` → open **PR** in zone repo via `gh`. Never direct push. Zone
  repo review = second human gate + audit trail for free.
- Origin doc get `promoted_to: company/platform/<slug>` pointer. Full private note
  never duplicated — only curated copy leave.
- Reversible: revert PR = demotion. Origin pointer cleared by `kns promote revoke`.

### 6.4 Demand signal without surveillance

Open question from source doc: cross-user retrieval counts imply telemetry, must not
leak who-searched-what.

Design:

- Counters **local-only by default**. Nothing export unless opt-in flag.
- Export unit = `(zoneName, documentId, bucketedCount, weekEpoch)`. No query text. No
  user id.
- **k-anonymity threshold**: document not exported unless ≥ `kMin` distinct reporters
  (default 5) that week. Enforced at aggregator — client send counts under a rotating
  pseudonymous id, aggregator drop anything below threshold.
- Counts bucketed (1-2, 3-5, 6-10, 10+) to blunt fingerprinting.
- Whole feature ship **off**. §6.1 work fine without it.

### 6.5 Demotion / review TTL

Shared-zone rot is the failure mode that kill precision. So:

- Every promoted doc carry `review_by` and `origin_owner`.
- `kns review --zone <z>` list past-TTL and unowned docs.
- Output = demotion PR (remove or archive) or renewal (bump `review_by`).
- Rank `authority` factor (§5.4) already down-weight past-TTL docs, so rot degrade
  gracefully before a human clean up.

---

## 7. Quality gates

Two gates, both enforced in CI, both blocking merge. See
`docs/documentation-policy.md` and `CONTRIBUTING.md`.

### 7.1 Test coverage — minimum 80%

- Runner: `node --test` + `c8`. Thresholds: **lines 80, branches 80, functions 80,
  statements 80**. CI fail below.
- Threshold set in PR-01 and **never lowered**. Ratchet only up.
- Every PR in `docs/plan-prs.md` carry explicit `Tests:` line. No PR merge without
  tests for its own new branches.
- Layer split (target shape, not hard rule):

| Layer | Share | What |
|-------|-------|------|
| Unit | ~70% | ranker math, registry validation, sanitizer patterns, cache keys, TTL logic |
| Integration | ~20% | resolver against fake + real `zbrain-mcp` zones, cache hit/miss, partial failure |
| E2E | ~10% | `kns` CLI and `kns-mcp` over stdio against fixture corpora |

- Hard-to-cover code (process spawn, fs errors) get injected seams, not `c8` ignore
  comments. `c8` ignore need a reviewer-visible reason comment.
- **Property tests** for the ranker: monotonic in relevance, monotonic in freshness,
  deterministic under permutation of input order.
- **Golden tests** for every JSON envelope shape, so schema drift is loud.

### 7.2 Documentation coverage — 100% of public surface

`npm run docs:check` fail if any of:

1. Exported TS symbol missing TSDoc (`eslint-plugin-jsdoc`, `require-jsdoc` on
   exports).
2. CLI command/flag exists in code but missing from `docs/contract-cli.md`.
3. MCP tool or input field exists in code but missing from `docs/contract-mcp.md`.
4. Config key exists in schema but missing from `docs/configuration.md`.
5. Markdown link in `docs/` point at missing file or missing anchor.

Checks 2-4 are generated-vs-committed diffs: code is source of truth, doc is
committed artifact, CI diff them. Doc drift become a failing build, not a TODO.

Doc set that must exist by 0.1.0:

| Doc | Content |
|-----|---------|
| `README.md` | what, install, 5-minute quickstart |
| `DESIGN.md` | this file |
| `ROADMAP.md` | milestones |
| `docs/plan-prs.md` | PR breakdown |
| `docs/contract-cli.md` | every command, flag, exit code, JSON envelope |
| `docs/contract-mcp.md` | every tool, input, output, error code |
| `docs/configuration.md` | every config key, default, range |
| `docs/zones.md` | zone setup, git sync, ACL, delegation |
| `docs/promotion.md` | promotion workflow end to end, sanitizer rules |
| `docs/privacy.md` | data flow, what leave machine, what never do |
| `docs/threat-model.md` | assets, adversaries, mitigations, residual risk |
| `docs/documentation-policy.md` | rules above |
| `docs/evals.md` | harness, metrics, current numbers |
| `docs/adr/` | one ADR per irreversible choice |
| `CONTRIBUTING.md` | setup, test, coverage, review bar |

---

## 8. Evaluation

Cannot tune §5.4 weights or §5.5 thresholds by vibe. Harness ship early (PR-11).

Multi-tier synthetic corpus fixture: same topic present at 3 zones with known correct
authority. Metrics:

| Metric | Meaning | Guard |
|--------|---------|-------|
| `recall@k` | did right chunk surface | must not drop vs USER-only baseline |
| `authority@1` | top hit from correct-authority zone | primary quality metric |
| `fanoutRate` | % queries that left distance 0 | cost proxy |
| `p95ResolveMs` | latency | USER-only p95 + budget |
| `leakCount` | private-fixture content appearing in shared zone output | **must be 0** |

`leakCount` is a release gate. Non-zero = no ship.

---

## 9. Privacy & security

- **Default private.** Nothing leave USER without explicit promotion + human approval
  + PR review.
- **ACL per zone** = repo permission / IdP group. No new ACL system.
- **Fail closed** on sanitizer error, registry parse error, unknown transport kind.
- **No remote transport in v1.** stdio to local `zbrain-mcp` only. Shared zones reach
  the machine via git, not via network query. Attack surface shrink to git auth
  already trusted.
- **No bootstrap scripts.** Install = `npm install` + explicit `kns zone add`. No
  `curl | bash`, no post-install hook, no auto-fetch of registry over network.
- Cache and indexes = sensitive local data. Gitignored and documented as such.
- Threat model doc ship with 0.1.0 (PR-20).

---

## 10. Tech choices

| Choice | Pick | Why |
|--------|------|-----|
| Zone engine | **ZBrain** (existing) | already local-first, SQLite/FTS5, stdio MCP, bounded read-only tools. Zero new infra. |
| Runtime | Node 22 + TypeScript, ESM | match ZBrain runtime; TS for resolver/merge schema safety |
| Transport | MCP stdio client | ZBrain already speak it; nothing to operate |
| Fusion | RRF | no cross-backend score calibration needed |
| Cache | SQLite | same dependency footprint as ZBrain |
| Zone distribution | git repo of markdown | ACL, audit, review, revert all free |
| Publish path | `gh pr create` | human gate + audit trail without building one |
| Test/coverage | `node --test` + `c8` @ 80% | stdlib runner, no framework lock-in |

Rejected:

- **Qdrant / pgvector shared cluster** — infra to run, ACL to invent, cost. Revisit
  only if a zone exceed ZBrain corpus caps (20k docs / 100MB).
- **One flat company index** — that is the problem, not the solution (§2).
- **Auto-promotion** — privacy boundary need a human. Non-negotiable.
- **HTTP zone query in v1** — bigger attack surface, auth work. Git sync enough.

---

## 11. Open questions

| # | Question | Current lean |
|---|----------|--------------|
| Q1 | Early-exit threshold values | tune in PR-11 harness; start conservative (rarely exit) |
| Q2 | Zone discovery bootstrap | `zones.json` explicit, hand-added. Auto-discovery later, need auth story. |
| Q3 | Demand signal privacy | k-anonymity + bucketing (§6.4), ship off by default |
| Q4 | Conflict when zones disagree | freshness × authority in rank (§5.4) + surface `conflict: true` on result |
| Q5 | Cost at N users × M zones | early-exit + TTL cache + git sync (no per-query network). Measure `fanoutRate`. |
| Q6 | Corpus scale ceiling | ZBrain caps 20k docs / 100MB. Company zone may exceed → shard via sub-zone delegation |

---

## 12. Success criteria

- Teammate retrieve promoted answer without knowing who wrote it or where it live.
- USER-only retrieval latency and precision unchanged (early-exit hold).
- Zero unintended private-content leak. Every promotion pass sanitizer + human gate +
  PR review. `leakCount == 0` in eval.
- Measurable drop in duplicated / re-derived knowledge inside a team.
- Swap one MCP server in agent config → whole hierarchy available.
- Coverage ≥ 80% and `docs:check` green on every commit to `main`.

---

## 13. See also

- `ROADMAP.md` — milestones M0–M4
- `docs/plan-prs.md` — 20 PR breakdown
- `docs/documentation-policy.md` — doc coverage rules
- ZBrain — https://github.com/Zhachory1/ZBrain
