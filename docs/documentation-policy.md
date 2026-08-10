# Documentation policy

Documentation coverage is a blocking CI gate, on the same footing as test coverage.
The rule is simple: **100% of the public surface is documented, and the check is
mechanical rather than a review habit.**

## What "public surface" means

| Surface | Documented in | How it is checked |
|---------|---------------|-------------------|
| Exported TypeScript symbols | TSDoc at the declaration | `eslint-plugin-jsdoc`, `require-jsdoc` restricted to exports |
| CLI commands, flags, exit codes | `contract-cli.md` | generated from the command registry, diffed against the committed file |
| MCP tools, inputs, outputs, error codes | `contract-mcp.md` | generated from the tool registry, diffed against the committed file |
| Config keys, defaults, valid ranges | `configuration.md` | generated from the config schema, diffed against the committed file |
| JSON envelope shapes | `contract-schemas.md` | generated from the type definitions, diffed against the committed file |
| Links between docs | — | every Markdown link in `docs/` must resolve to an existing file and anchor |

`npm run docs:check` fails on any violation. Because the contract documents are
generated and diffed, drift becomes a red build instead of a stale paragraph that
nobody notices for six months.

## Generated versus written

- **Generated and committed:** `contract-cli.md`, `contract-mcp.md`,
  `configuration.md`, `contract-schemas.md`. Regenerate with `npm run docs:gen` and
  commit the result. Do not hand-edit — the generator will overwrite you and CI will
  catch the divergence.
- **Written by hand:** everything else. The generator never touches prose.

## Required documents

These must exist and be non-empty by the 0.1.0 release. `docs:check` enforces
presence from PR-01 onward, so they start as skeletons and fill in as features land.

| Document | Content |
|----------|---------|
| `README.md` | What this is, install, five-minute quickstart |
| `DESIGN.md` | Architecture, algorithms, privacy model, quality gates |
| `ROADMAP.md` | Milestones M0–M4 |
| `CONTRIBUTING.md` | Setup, tests, coverage, review bar, non-negotiables |
| `docs/plan-prs.md` | PR-by-PR implementation plan |
| `docs/contract-cli.md` | Every command, flag, exit code, JSON envelope |
| `docs/contract-mcp.md` | Every MCP tool, input, output, error code |
| `docs/contract-schemas.md` | Every envelope and domain type |
| `docs/configuration.md` | Every config key with default and range |
| `docs/zones.md` | Zone setup, git sync, ACL, delegation |
| `docs/ranking.md` | Fusion, priors, early exit, conflict handling, worked example |
| `docs/caching.md` | TTL cache behavior, keys, invalidation, purge |
| `docs/promotion.md` | Promotion end to end: signals, sanitizer, draft, publish, revoke |
| `docs/privacy.md` | Data flow, what leaves the machine, what never does |
| `docs/threat-model.md` | Assets, adversaries, trust boundaries, mitigations, residual risk |
| `docs/operations.md` | Runbooks: degraded zones, cache purge, review sweeps |
| `docs/evals.md` | Harness, metrics, committed baseline numbers |
| `docs/documentation-policy.md` | This file |
| `docs/adr/` | One ADR per irreversible decision |

## Writing rules

- **Every behavior claim is testable.** If a document says a zone timeout yields a
  partial result, a test asserts exactly that. Documents describing behavior that no
  test covers are a review blocker.
- **Numbers belong in tables, not prose.** Defaults, thresholds, and limits go in a
  table with the units spelled out.
- **Show the envelope.** Any document describing an interface includes a real JSON
  example, copied from a test fixture so it cannot rot.
- **Say what fails and how.** Every error path documents its error code and what the
  caller should do next.
- **Privacy claims are specific.** "Private by default" alone is not enough. Name the
  file, the boundary, and the gate.

## ADRs

One ADR per decision that is expensive to reverse. Format: context, decision,
consequences, alternatives rejected and why. Numbered, immutable once merged — a
later ADR supersedes an earlier one rather than editing it.

Initial set (lands with PR-20):

1. Reuse ZBrain as the per-zone engine instead of building or hosting a vector store
2. Reciprocal Rank Fusion instead of cross-backend score normalization
3. Git synchronization instead of an HTTP query transport for shared zones
4. Pull-request-only publishing instead of a direct write path

## Style

Design documents, roadmaps, and plans in this repository use the author's terse
house style. Reference documentation, contracts, and this policy use ordinary prose.
Code blocks, schemas, tables, and error strings are always exact in either case.
