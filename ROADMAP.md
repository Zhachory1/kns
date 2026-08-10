# KNS Roadmap

Milestones M0–M4. Each milestone ship something usable. Each PR keep `main` green:
coverage ≥ 80%, `docs:check` green. See `docs/plan-prs.md` for PR detail.

Prose terse (caveman style). Gates and numbers exact.

---

## Shape

```
M0 scaffold ──▶ M1 one zone ──▶ M2 many zones ──▶ M3 promotion ──▶ M4 root + scale
   PR-01..02      PR-03..05       PR-06..11        PR-12..16        PR-17..20
```

Order follow source-doc phased rollout: USER-only → resolver seam → TEAM +
promotion → COMPANY root + signals.

---

## M0 — Scaffold and contracts

**PRs:** 01–02 · **Ship:** nothing user-facing. Rails only.

Goal: repo where every later PR is cheap and safe.

- Node 22 + TypeScript ESM, `node --test` + `c8` at **80% floor** wired day one.
- CI: lint, typecheck, test+coverage, `docs:check`. All blocking.
- Core types: `Zone`, `Tier`, `Hit`, `Provenance`, `ResolveEnvelope`. Versioned
  `schemaVersion: 1`.

**Exit:** CI green on empty-ish repo. Coverage gate proven to fail when dropped.
Doc skeleton files exist and `docs:check` enforce them.

**Risk:** over-engineering scaffold. Cap M0 at two PRs.

---

## M1 — Resolve one zone (no behavior change)

**PRs:** 03–05 · **Ship:** `kns resolve` over the local ZBrain, annotated.

Goal: build the seam without changing what user get. Matches rollout phase 1–2.

- Zone registry `~/.kns/zones.json` + `kns zone list|add|remove`.
- MCP stdio client adapter → `zbrain-mcp` (spawn, initialize, `tools/call`, timeout,
  kill, no zombie).
- Single-zone passthrough resolver. Result carry tier, zone, owner, age.

**Exit:** `kns resolve "x"` return same docs as `zbrain search "x"`, plus provenance.
Latency delta vs raw ZBrain < 50ms p95. Adapter kill leftover child on timeout
(tested).

**Risk:** subprocess lifecycle bugs. Mitigate with integration tests against real
`zbrain-mcp` on fixture corpus.

---

## M2 — Many zones, ranked, cached

**PRs:** 06–11 · **Ship:** real hierarchical resolution + eval numbers.

Goal: the DNS behavior. This is where design either work or not.

- Ranker: RRF + nearness + freshness + authority. Deterministic.
- Fan-out by distance group, parallel within group, per-zone deadline, partial
  failure tolerated.
- Authoritative early-exit with config thresholds and escape hatches.
- TTL cache in SQLite keyed `(zone, chunkId, sourceVersion)`.
- `kns-mcp` stdio server — drop-in swap for `zbrain-mcp` in agent config.
- Eval harness with multi-tier fixtures.

**Exit:**
- `authority@1` beat USER-only baseline on fixtures.
- `recall@k` not regress vs USER-only.
- `fanoutRate` reported; early-exit thresholds picked **from harness numbers**, not
  guessed.
- One dead zone → degraded result + warning, never a failed query (tested).
- `leakCount == 0`.

**Risk:** ranking weights overfit to synthetic fixtures. Mitigate: fixtures built from
adversarial cases (stale-company-vs-fresh-team, weak-local-vs-strong-company), and
weights stay config, not constants.

---

## M3 — Promotion (the write path)

**PRs:** 12–16 · **Ship:** knowledge actually cross the boundary, safely.

Goal: turn "local note" into "team knowledge" without leaking anything.

- Candidate suggestion from frontmatter + doc kind + link graph.
- Sanitizer gate: secrets = hard fail, PII = redact + flag. Fail closed.
- Draft writer with provenance frontmatter + review TTL.
- Publish only via `gh pr create`. Never direct push. Origin get `promoted_to:`
  pointer. `kns promote revoke` undo it.
- Conflict handling when two zones disagree: `conflict: true` on results.

**Exit:**
- Adversarial sanitizer corpus (planted keys, tokens, PII) → **zero** escape.
- Publish path cannot write outside target zone worktree (tested).
- Full round trip: local note → PR → merge → zone reindex → teammate resolve it.
- Revert PR → doc gone from results next sync.

**Risk:** sanitizer false-confidence. Mitigate: hard fail on secrets, human gate is
mandatory not skippable, adversarial corpus is a permanent test suite that grow with
each near-miss.

---

## M4 — Company root, signals, scale, 0.1.0

**PRs:** 17–20 · **Ship:** taggable release.

- Demand signal, local-only default, k-anonymity + bucketing when exported.
- Demotion / review TTL sweep → `kns review` open demotion or renewal PRs.
- Zone delegation and sub-zones — namespace prefix resolution, shard a big zone.
- Hardening: threat model, privacy doc, ADRs, install path, `0.1.0` tag.

**Exit:** three-tier setup running on one machine. All docs present. Coverage ≥ 80%.
`docs:check` green. Threat model reviewed. Tag cut.

**Risk:** company zone exceed ZBrain caps (20k docs / 100MB). Mitigate: delegation
land before root zone grow — that is why PR-19 sit before release.

---

## Cross-cutting, every milestone

| Gate | Rule |
|------|------|
| Coverage | ≥ 80% lines/branches/functions/statements. Ratchet up only. |
| Docs | `docs:check` green. Public surface 100% documented. |
| Privacy | `leakCount == 0` in eval. Sanitizer fail closed. |
| Determinism | Same input → same ranked output. Property-tested. |
| Size | One concern per PR. Target < 400 changed lines. |

---

## Sequencing rules

- **Eval before tuning.** PR-11 land before early-exit or weight values get argued.
- **Sanitizer before publish.** PR-13 land before PR-15. Non-negotiable ordering.
- **Delegation before root.** PR-19 before tagging, or company zone hit caps.
- Anything blocked → skip ahead only inside same milestone, never across.

---

## Out of scope for 0.1.0

- HTTP/remote zone transport (git sync cover it).
- Multi-user hosted aggregator for demand signal (local counters only).
- Non-markdown corpora, code retrieval.
- Auto-promotion of any kind.
- Vector DB migration (only if ZBrain caps hit).
