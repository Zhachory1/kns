# Threat model

**Status:** skeleton. Completed in PR-20; the sanitizer section is filled in PR-13.

## Assets

| Asset | Why it matters |
|-------|----------------|
| Private notes in the `USER` zone | The corpus is unfiltered: drafts, half-thoughts, credentials pasted while debugging |
| Secrets inside those notes | Leaking one into a shared zone is irreversible in practice |
| Shared zone integrity | A shared zone that anyone can write to silently is a knowledge-poisoning vector |
| The zone registry | It decides which process gets your queries |

## Adversaries and mitigations

**A careless promotion.** The most likely failure by a wide margin. Mitigated by the
sanitizer failing closed on secrets, by redaction plus flagging for personal data, by
a mandatory confirmation flag, and by publishing only through a reviewed pull request.
Four gates, because the failure is not reversible once content is in a shared history.

**A prompt-injected agent.** An agent reading untrusted content could attempt to call
tools with attacker-chosen arguments. Mitigated by MCP tools being read-only and
bounded, by tool calls not accepting filesystem roots (roots come from the registry),
and by there being no promotion tool at all — promotion needs a human at a terminal.

**A malicious or compromised zone.** A zone returns whatever it wants, including
content crafted to be retrieved. Mitigated by provenance on every hit, so a reader
always sees which zone and which owner an answer came from, and by shared zones being
repositories whose changes go through review.

**A hostile registry entry.** `transport.command` names a process to spawn. Mitigated
by the registry being local-only — never fetched over the network — by validation
rejecting unknown transport kinds, and by failing closed on a malformed registry.

**Local disk access.** Someone with your filesystem already has your notes; the cache
adds shared-zone excerpts you were entitled to read. Mitigated by documenting the
cache as sensitive, gitignoring it, and providing purge.

## Trust boundaries

1. `USER` zone to shared zone — the important one. Crossed only by promotion.
2. KNS to zone process — stdio, local, spawned from a validated registry entry.
3. Machine to remote — git only, using credentials you already have.

## Residual risk

- The sanitizer is pattern-based. A secret in a shape nobody has seen can pass it. The
  human gate and pull-request review are the compensating controls, and every miss
  becomes a permanent test case.
- Redaction can mangle meaning. That is why personal data is flagged for review rather
  than silently rewritten.
- A user with write access to a shared zone can bypass KNS entirely and commit
  directly. That is a repository permissions question, not something KNS can enforce.
