# Contributing to KNS

## Setup

Requires Node.js >= 22 and `sqlite3` with FTS5 (same prerequisites as ZBrain).

```bash
npm install
npm test                  # node --test with c8 coverage
npm run lint
npm run typecheck
npm run docs:check
```

`npm run check` runs all four in the order CI does.

Nothing in this repository fetches or executes remote code during install. There is
no post-install hook and no bootstrap script; if you are ever asked to pipe a script
into a shell to set this project up, that is a bug, not a step.

## The two blocking gates

### 1. Test coverage ≥ 80%

Thresholds live in `.c8rc.json`: lines 80, branches 80, functions 80, statements 80,
with `check-coverage: true`. CI fails below any of them.

- The threshold **ratchets up only**. Lowering it in a PR is a review blocker.
- Tests ship in the same PR as the code they cover. "Tests next PR" is not a thing
  here.
- Target shape: ~70% unit, ~20% integration, ~10% end-to-end.
- Prefer injectable seams over `c8` ignore comments for hard-to-reach code
  (subprocess spawning, filesystem errors). Any `c8 ignore` needs a comment
  explaining why, visible to the reviewer.
- Pure logic — the ranker, validators, the sanitizer — is expected at or near 100%.
  There is no excuse for uncovered branches in code with no I/O.
- The ranker additionally carries property tests: monotonic in relevance, monotonic
  in freshness, and invariant under permutation of input order.

### 2. Documentation coverage 100% of the public surface

`npm run docs:check` fails if any of the following is true:

1. An exported TypeScript symbol has no TSDoc comment.
2. A CLI command or flag exists in code but is missing from `docs/contract-cli.md`.
3. An MCP tool or input field exists in code but is missing from
   `docs/contract-mcp.md`.
4. A config key exists in the schema but is missing from `docs/configuration.md`.
5. A Markdown link inside `docs/` points at a missing file or anchor.

Checks 2–4 work by generating the contract from code and diffing it against the
committed document. Code is the source of truth; the committed doc is the artifact.
If you change the surface, regenerate and commit.

Full rules: [`docs/documentation-policy.md`](docs/documentation-policy.md).

## PR shape

One concern per PR, under 400 changed lines excluding fixtures and lockfiles. The
implementation sequence and the per-PR scope are in
[`docs/plan-prs.md`](docs/plan-prs.md) — please follow the ordering, especially:

- The sanitizer (PR-13) lands before any drafting or publishing path (PR-14, PR-15).
- The eval harness (PR-11) lands before ranking weights or early-exit thresholds are
  given real values.
- Zone delegation (PR-19) lands before the 0.1.0 release.

Checklist to copy into your PR description:

- [ ] One concern; < 400 changed lines (fixtures excluded)
- [ ] Unit tests for every new branch
- [ ] Integration or E2E test if the PR crosses a process or filesystem boundary
- [ ] `npm test` coverage ≥ 80% on all four metrics; threshold not lowered
- [ ] `npm run docs:check` green
- [ ] Contract docs regenerated and committed if the CLI/MCP/config surface changed
- [ ] Error paths fail closed
- [ ] No new network call, bootstrap script, or post-install hook
- [ ] `docs/evals.md` numbers refreshed if ranking or resolution changed

## Non-negotiables

These are design invariants, not preferences. A PR that weakens one needs a design
change in `DESIGN.md` first.

- **Nothing leaves the USER tier without a human.** No automatic promotion, ever.
- **The sanitizer fails closed.** A detected secret blocks the draft. A detector that
  throws blocks the draft. There is no override flag.
- **Publishing goes through a pull request.** Never a direct push to a zone's default
  branch, never a force push.
- **A dead zone degrades the result; it never fails the query.** Partial results plus
  a warning, not an exception.
- **Resolution is deterministic.** The same inputs produce the same ranked output.
- **No telemetry by default.** Demand signals are local-only unless explicitly
  exported, and the export never contains query text or user identity.

## Commits

Conventional Commits — `feat(scope):`, `fix(scope):`, `chore(scope):`,
`docs(scope):`. The scope matches the module (`registry`, `resolve`, `rank`, `cache`,
`mcp`, `promote`, `eval`).
