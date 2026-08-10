# KNS — PR Plan (20 PRs)

Implementation plan for `DESIGN.md`, sequenced per `ROADMAP.md`.

Rules for every PR below:

- One concern. Target < 400 changed lines (excluding fixtures/lockfile).
- **Tests ship in the same PR.** Coverage floor 80% (lines/branches/functions/
  statements) enforced by `c8` in CI. Never lowered.
- **Docs ship in the same PR.** `npm run docs:check` must be green — public surface
  100% documented, contracts regenerate-and-diff clean.
- `main` green after every merge. No "fix it next PR".

Prose terse (caveman style). Commands, thresholds, filenames exact.

---

## M0 — Scaffold and contracts

### PR-01 · chore: repo scaffold, CI, coverage floor, docs gate

**Why first:** every later PR lean on these rails. Build them once.

**Scope**
- `package.json` (Node >= 22, ESM, `bin: { kns, kns-mcp }` stubs), `tsconfig.json`
  (strict, `NodeNext`), ESLint + `eslint-plugin-jsdoc`, Prettier.
- `node --test` + `c8`. `.c8rc.json` thresholds: lines 80, branches 80, functions 80,
  statements 80, `check-coverage: true`.
- `scripts/docs-check.mjs` skeleton: markdown link/anchor validation + "every doc in
  required list exists".
- GitHub Actions `ci.yml`: install → lint → typecheck → `npm test` (with coverage) →
  `npm run docs:check`. All blocking. Matrix Node 22.
- `LICENSE` (MIT), `.gitignore` (`node_modules`, `dist`, `.kns/`, `*.sqlite`,
  `coverage/`, `.zbrain/`), `README.md` skeleton, `CONTRIBUTING.md`.

**Tests:** one trivial unit test proving runner works; a CI self-test that coverage
gate **fails** when a threshold is raised above actual (proves gate is live, not
decorative).

**Docs:** `README.md`, `CONTRIBUTING.md` (setup/test/coverage/review bar),
`docs/documentation-policy.md`.

**Exit:** green CI. Deliberately breaking a threshold turn CI red.
**Size:** ~250 lines.

---

### PR-02 · feat(core): domain types, envelopes, schema versioning

**Scope**
- `src/core/types.ts`: `Tier` (`USER|TEAM|COMPANY`), `Zone`, `Transport`, `Hit`,
  `Provenance`, `ResolveEnvelope`, `Warning`, `ErrorEnvelope`.
- Every envelope carry `schemaVersion: 1`.
- Runtime validators (hand-written or `zod`) — parse, never trust.
- Error codes enum: `invalid_request`, `zone_unavailable`, `zone_timeout`,
  `registry_invalid`, `sanitizer_blocked`, `internal`.

**Tests:** validator accept/reject tables per type; unknown field rejection; envelope
golden snapshots.
**Docs:** `docs/contract-schemas.md` generated from types, committed, CI-diffed.

**Exit:** types importable, 100% covered (pure code, no excuse).
**Size:** ~300 lines.

---

## M1 — Resolve one zone

### PR-03 · feat(registry): zones.json load, validate, order

**Scope**
- Load `~/.kns/zones.json` (override `KNS_HOME`). Validate against PR-02 schema.
- `registry.order()` → zones sorted by `distance` asc, grouped by equal distance.
- Namespace prefix matching for scoped queries (`--scope company/platform`).
- CLI: `kns zone list|add|remove|show` with `--json`.
- **Fail closed:** malformed registry → `registry_invalid`, no partial load. Unknown
  `transport.kind` → refuse. No network fetch of registry, ever.

**Tests:** valid/invalid/duplicate-name/duplicate-distance fixtures; ordering and
grouping; namespace prefix match incl. non-matches; CLI JSON envelopes.
**Docs:** `docs/zones.md`, `docs/configuration.md` (every key, default, range),
`docs/contract-cli.md` (zone commands).

**Exit:** `kns zone list --json` correct on 3-zone fixture.
**Size:** ~350 lines.

---

### PR-04 · feat(client): MCP stdio adapter for zbrain-mcp

**Scope**
- `ZoneClient` interface: `search(query, k, filters)`, `get(id, from, lines)`,
  `status()`, `close()`.
- `StdioZoneClient`: spawn `zbrain-mcp --root <path>`, JSON-RPC `initialize` →
  `notifications/initialized` → `tools/call`.
- Per-call deadline; on timeout kill child (SIGTERM → SIGKILL escalation), no zombie.
- Map ZBrain error envelope → KNS error codes.
- Connection pooling: one child per zone, lazily spawned, reused, closed on exit.

**Tests:** fake stdio server for unit tests (malformed JSON, slow reply, crash
mid-stream, non-zero exit, huge payload); integration test against **real**
`zbrain-mcp` on fixture corpus; leak test asserting no surviving child after timeout.
**Docs:** `docs/contract-mcp.md` (client side + assumptions on ZBrain).

**Exit:** adapter survives every fault-injection case without hanging or leaking.
**Size:** ~400 lines.

---

### PR-05 · feat(resolve): single-zone passthrough with provenance

**Scope**
- `resolve()` over exactly one zone. No ranking yet, preserve backend order.
- Annotate each hit: `tier`, `zone`, `namespace`, `owner`, `ageDays`, `rankWithinZone`.
- CLI `kns resolve <query> [--k] [--scope] [--json]`.
- Latency instrumentation: `resolveMs`, per-zone timings in envelope.

**Tests:** annotation correctness (age from frontmatter/mtime, missing owner →
`null`); order preservation; E2E CLI against fixture corpus.
**Docs:** `docs/contract-cli.md` (resolve), README quickstart made real.

**Exit:** `kns resolve` match `zbrain search` result set exactly, plus provenance.
p95 overhead < 50ms.
**Size:** ~250 lines.

---

## M2 — Many zones, ranked, cached

### PR-06 · feat(rank): RRF fusion + nearness/freshness/authority priors

**Scope**
- `score = rrf * nearness * freshness * authority` per `DESIGN.md` §5.4.
- Config: `rrfK` (60), `nearnessBase` (0.9), per-zone `halfLifeDays`,
  `unownedPenalty`, `staleFactor`.
- Dedup: same `documentId` from two zones collapse to one hit, keep `alsoIn: [...]`.
- Deterministic tie-break `(score desc, distance asc, documentId asc)`.

**Tests:** unit tables per factor; **property tests** — monotonic in rank, monotonic
in freshness, permutation-invariant output, no NaN/Infinity on edge inputs (age 0,
huge age, missing fields); dedup with conflicting metadata.
**Docs:** `docs/ranking.md` with worked example; `docs/configuration.md` updated.

**Exit:** ranker pure, deterministic, 100% branch covered.
**Size:** ~300 lines.

---

### PR-07 · feat(resolve): multi-zone fan-out, deadlines, partial failure

**Scope**
- Walk distance groups ascending; within group query zones in parallel
  (`Promise.allSettled`).
- Per-zone deadline `zoneDeadlineMs`, global `resolveDeadlineMs`.
- Zone failure → `warnings[]` entry + `partial: true`. **Never throw.**
- Concurrency cap so N zones not spawn N children at once.

**Tests:** all-fail → empty result + warnings, exit code still 0; one-slow → dropped
at deadline, others returned; global deadline preempt; concurrency cap respected;
warning envelope golden.
**Docs:** `docs/contract-cli.md` (partial semantics + exit codes),
`docs/operations.md` (what a degraded result look like).

**Exit:** kill a zone mid-query → degraded answer, no hang, no crash.
**Size:** ~350 lines.

---

### PR-08 · feat(resolve): authoritative early-exit policy

**Scope**
- `authoritative()` per `DESIGN.md` §5.5: rank-1 margin, max age, min hits,
  `mode != broad`.
- Config thresholds; escape hatches `--no-early-exit`, `mode: "broad"`, per-zone
  `neverEarlyExit`.
- Emit `earlyExitAt: <distance> | null` and `zonesQueried[]` in envelope.

**Tests:** truth table over the four conditions (each alone blocks exit); escape
hatches force full fan-out; `earlyExitAt` reporting; boundary values exactly at
threshold.
**Docs:** `docs/ranking.md` early-exit section, `docs/configuration.md`.

**Exit:** thresholds are config with conservative defaults. Real values set in PR-11
from harness numbers — **not** in this PR.
**Size:** ~200 lines.

---

### PR-09 · feat(cache): TTL cache for remote zone hits

**Scope**
- SQLite at `~/.kns/cache.sqlite`. Key `(zoneName, chunkId, sourceVersion)`.
- `sourceVersion` from zone `status()` index generation + doc hash.
- Per-zone `ttlSeconds`; USER tier never cached.
- Store snippet + metadata only, same bounds as MCP output.
- `kns cache stats|purge [--zone]`. Size cap with LRU eviction.
- Cache file gitignored, documented as sensitive local data.

**Tests:** hit/miss/expiry; version bump invalidate; USER never cached; LRU eviction
at cap; corrupt DB → rebuild, not crash; concurrent access.
**Docs:** `docs/caching.md`, `docs/privacy.md` (what cache hold, how to purge).

**Exit:** warm-cache resolve measurably faster; stale entry never served past TTL.
**Size:** ~350 lines.

---

### PR-10 · feat(mcp): kns-mcp stdio server

**Scope**
- Tools: `kns.resolve`, `kns.get`, `kns.answer`, `kns.zones`, `kns.status`.
- Same wire behavior as ZBrain (`initialize`, `tools/list`, `tools/call`, content
  blocks, `isError`).
- Read-only, bounded output. Input validation reuse PR-02 validators.
- Drop-in config snippet for agent clients.

**Tests:** protocol conformance per method; malformed request handling; bounds
enforcement (limit 1–20, lines 1–200); error envelope shapes; E2E over real stdio
pipe.
**Docs:** `docs/contract-mcp.md` complete (every tool, input, output, error), README
"swap one server" section.

**Exit:** point an agent at `kns-mcp` instead of `zbrain-mcp` → hierarchy works, no
other config change.
**Size:** ~400 lines.

---

### PR-11 · feat(eval): multi-tier harness, metrics, threshold tuning

**Scope**
- Synthetic 3-zone corpus: same topics at multiple zones, known correct authority.
  Adversarial cases: stale-company-vs-fresh-team, weak-local-vs-strong-company,
  duplicate-across-zones, private-only-doc.
- Metrics: `recall@k`, `authority@1`, `fanoutRate`, `p95ResolveMs`, `leakCount`.
- `npm run bench:tiers` → JSON + markdown readout.
- **Set real early-exit thresholds and rank weights from these numbers.** Record
  before/after in `docs/evals.md`.

**Tests:** harness self-tests on a corpus with known-correct answers; metric math unit
tests; regression test pinning current numbers with tolerance.
**Docs:** `docs/evals.md` with committed baseline table.

**Exit:** `authority@1` beat USER-only baseline; `recall@k` not regress;
`leakCount == 0`. Numbers committed.
**Size:** ~400 lines + fixtures.

---

## M3 — Promotion

### PR-12 · feat(promote): candidate detection and suggestions

**Scope**
- Parse frontmatter: `share`, doc `kind`, `review_by`, `owner`.
- Link graph over local corpus → inbound link counts.
- Scoring per `DESIGN.md` §6.1. `share:` is hard yes; past review TTL is hard block.
- CLI `kns promote suggest [--to <zone>] [--json]`. **Suggest only. Write nothing.**

**Tests:** signal table per rule; hard-yes and hard-block precedence; link graph on
fixture corpus incl. cycles and broken links; assert command performs zero writes.
**Docs:** `docs/promotion.md` (signals section).

**Exit:** suggestions ranked and explainable — each carry `reasons[]`.
**Size:** ~300 lines.

---

### PR-13 · feat(promote): sanitizer gate (secrets hard-fail, PII redact)

**Ordering:** must land **before** PR-14/PR-15. Nothing may draft or publish without
this.

**Scope**
- Secret detectors: cloud access keys, VCS tokens, private-key blocks, JWTs, bearer
  tokens, `.env`-style assignments, high-entropy strings (tunable threshold).
- PII detectors: email, phone, postal address, person names from local people pages.
- Configurable term blocklist (org-confidential vocabulary).
- API: `sanitize(text) -> { blocked, findings[], redacted }`. **Secret ⇒ blocked.**
  PII ⇒ redacted + flagged.
- Fail closed: detector throw ⇒ blocked.

**Tests:** adversarial corpus of planted secrets (each family, plus base64/split/
whitespace-obfuscated variants) → **zero escapes**; false-positive corpus (UUIDs,
git SHAs, sample keys in code fences) to bound noise; detector-throws ⇒ blocked;
redaction never widen or corrupt surrounding text.
**Docs:** `docs/promotion.md` sanitizer section, `docs/privacy.md`,
`docs/threat-model.md` first draft.

**Exit:** adversarial corpus 100% blocked. Corpus is permanent and grow with each
near-miss.
**Size:** ~400 lines + fixtures.

---

### PR-14 · feat(promote): sanitized draft writer with provenance

**Scope**
- `kns promote draft <docId> --to <zone>` → run sanitizer, render promotable copy.
- Provenance frontmatter: `promoted_from`, `promoted_by`, `promoted_at`,
  `origin_owner`, `review_by` (default +180d), `canonical`.
- Write into target zone worktree only. Path traversal refused. Never touch origin.
- `--dry-run` print diff and exit.

**Tests:** blocked doc ⇒ no file written (assert filesystem unchanged); frontmatter
correctness; path traversal (`../`, absolute, symlink) refused; idempotent re-draft;
dry-run writes nothing.
**Docs:** `docs/promotion.md` draft section, `docs/contract-cli.md`.

**Exit:** cannot produce a draft that sanitizer blocked. Cannot write outside target
zone.
**Size:** ~300 lines.

---

### PR-15 · feat(promote): publish via PR + origin backlink + revoke

**Scope**
- `kns promote publish` → branch in zone repo, commit, `gh pr create`. **Never push to
  the zone default branch. Never force push.**
- Re-run sanitizer immediately before commit (fail closed a second time).
- On PR creation, write `promoted_to:` pointer into origin doc frontmatter.
- `kns promote revoke <docId>` → clear pointer, open a removal PR.
- Require explicit confirmation flag; no silent publish path.

**Tests:** git operations against a local bare-repo fixture (no network); assert
default-branch push refused; assert force push refused; sanitizer re-run enforced;
pointer written only after PR created; revoke round trip; `gh` missing ⇒ clear
actionable error.
**Docs:** `docs/promotion.md` publish + revoke, `docs/operations.md` runbook.

**Exit:** full round trip on fixture repos: local note → PR → merge → reindex →
resolve from another zone. Revert PR → gone next sync.
**Size:** ~400 lines.

---

### PR-16 · feat(resolve): cross-zone conflict detection

**Scope**
- Detect same-topic hits disagreeing across zones (shared `promoted_from` lineage, or
  high similarity + different content hash).
- Mark `conflict: true` with `conflictWith: [zone/docId]`.
- Ranking already prefer fresh + owned (PR-06); this surface it to the caller.
- `kns resolve --explain` print why a hit won.

**Tests:** stale-company-vs-fresh-team fixture → team wins and both flagged; lineage
detection via `promoted_from`; no false conflict on unrelated hits; `--explain` output
golden.
**Docs:** `docs/ranking.md` conflict section, `docs/evals.md` case added.

**Exit:** design open question Q4 closed with a test, not a paragraph.
**Size:** ~250 lines.

---

## M4 — Root, signals, scale, release

### PR-17 · feat(signal): local demand counters, opt-in k-anonymous export

**Scope**
- Local counters `(zoneName, documentId, week)` in cache DB. **Never** store query
  text or user id.
- Off-by-default export: bucketed counts (1-2, 3-5, 6-10, 10+), rotating pseudonymous
  reporter id, `kMin = 5` distinct reporters enforced at aggregator.
- `kns signal stats|export --confirm`. Export require explicit flag every time.
- Feed `promote suggest` (PR-12) when local counters available.

**Tests:** counters increment correctly; **assert no query text persisted anywhere**
(schema + content scan); export blocked without flag; bucketing boundaries;
k-anonymity drop below `kMin`; rotation changes id across periods.
**Docs:** `docs/privacy.md` demand-signal section, `docs/threat-model.md` updated.

**Exit:** feature ships off. With it off, zero behavior change and zero data written
beyond local counts.
**Size:** ~350 lines.

---

### PR-18 · feat(review): demotion and review-TTL sweep

**Scope**
- `kns review --zone <z>` → docs past `review_by` or missing `origin_owner`.
- Actions: `--renew` (bump TTL, open PR) or `--demote` (archive/remove, open PR).
- Rank `authority` factor already down-weight past-TTL docs (PR-06) — verify wiring
  end to end here.

**Tests:** TTL boundary cases (today, yesterday, missing field, malformed date);
unowned detection; PR content correctness against fixture repo; rank penalty applied
to stale docs.
**Docs:** `docs/operations.md` review runbook, `docs/promotion.md` lifecycle.

**Exit:** stale shared knowledge get flagged and removable in one command.
**Size:** ~300 lines.

---

### PR-19 · feat(zones): delegation and sub-zones

**Ordering:** land before release — company zone otherwise hit ZBrain caps (20k docs
/ 100MB).

**Scope**
- Namespace tree: `company` delegate `company/platform` delegate
  `company/platform/search-ranking`.
- Registry `delegatesTo` records; resolution honor longest matching namespace prefix.
- `--scope company/platform` restrict fan-out to that subtree.
- Cycle detection and depth cap. Fail closed on cycle.

**Tests:** prefix matching incl. near-miss (`company/plat` must not match
`company/platform`); delegation chain depth; cycle detection; scoped fan-out queries
only the subtree; shard a large fixture zone into two sub-zones and confirm recall
holds.
**Docs:** `docs/zones.md` delegation section with worked 3-level example.

**Exit:** design open question Q6 has a working answer.
**Size:** ~350 lines.

---

### PR-20 · chore(release): threat model, docs completeness, 0.1.0

**Scope**
- `docs/threat-model.md`: assets, adversaries, trust boundaries, mitigations, residual
  risk.
- ADRs for irreversible calls: reuse-ZBrain, RRF-over-score-normalization,
  git-over-HTTP-transport, PR-only-publish.
- `docs:check` upgraded to full enforcement: every exported symbol has TSDoc, CLI and
  MCP contracts regenerate clean, every config key documented.
- Install path documented — plain `npm install` + explicit `kns zone add`. **No
  `curl | bash`, no post-install hook, no network fetch of registry.**
- Coverage report published as CI artifact. Tag `v0.1.0`.

**Tests:** `docs:check` self-tests (undocumented export ⇒ fail; contract drift ⇒
fail; dead doc link ⇒ fail); smoke test of published tarball contents.
**Docs:** all of the above; README final.

**Exit:** three-zone setup works on one machine. Coverage ≥ 80%. `docs:check` green.
Threat model reviewed. Tag cut.
**Size:** ~300 lines + docs.

---

## Dependency graph

```
PR-01 ─▶ PR-02 ─┬─▶ PR-03 ─▶ PR-04 ─▶ PR-05 ─┬─▶ PR-06 ─┬─▶ PR-07 ─▶ PR-08
                │                             │          └─▶ PR-09
                │                             └────────────▶ PR-16
                └──────────────────────────────────────────▶ PR-10
                                        PR-07,08,09,10 ─▶ PR-11 (tunes 06 & 08)
PR-12 ─▶ PR-13 ─▶ PR-14 ─▶ PR-15 ─▶ PR-18
PR-11 ─▶ PR-17
PR-03 ─▶ PR-19
all ──▶ PR-20
```

Parallelizable pairs: (PR-09, PR-10), (PR-12, PR-16), (PR-17, PR-19).

Hard orderings: **PR-13 before PR-14/PR-15** (no publish path without sanitizer).
**PR-11 before final threshold values** in PR-06/PR-08. **PR-19 before PR-20.**

---

## Per-PR checklist

Copy into each PR description:

- [ ] One concern; < 400 changed lines (fixtures excluded)
- [ ] Unit tests for every new branch
- [ ] Integration/E2E test if PR cross a process or fs boundary
- [ ] `npm test` coverage ≥ 80% (all four metrics), threshold not lowered
- [ ] `npm run docs:check` green
- [ ] Contract docs regenerated and committed if CLI/MCP/config surface changed
- [ ] Error paths fail closed
- [ ] No new network call, no new bootstrap script, no post-install hook
- [ ] `docs/evals.md` numbers refreshed if ranking or resolution changed
