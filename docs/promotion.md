# Promotion

**Status:** skeleton. Suggestions land in PR-12, the sanitizer in PR-13, drafting in
PR-14, publishing and revocation in PR-15, the review sweep in PR-18.

Promotion is how a private note becomes team or company knowledge. It is the only path
by which anything leaves the `USER` tier, and it always has a human in it.

```
Local note ──suggest──▶ draft ──sanitize──▶ human approves ──▶ pull request
    │                                                              │
  private                                                     team access
    └──────────────── origin gets a promoted_to pointer ◀──────────┘
```

## Suggest

`kns promote suggest` ranks candidates and explains itself — every suggestion carries
`reasons[]`. It writes nothing.

| Signal | Effect |
|--------|--------|
| Frontmatter `share: team` or `share: company` | Hard yes |
| Document kind is a decision, concept, or solution | Strong |
| Many inbound links from other documents | Moderate |
| Teammates' resolvers keep retrieving it | Moderate, and off by default |
| Past its own `review_by` date | Blocked until refreshed |

## Sanitize

The gate runs on the draft and again immediately before publishing. A detected secret
**blocks** the promotion; there is no override flag. Personally identifying
information is redacted and flagged for the human to confirm. A detector that throws
also blocks — the gate fails closed, because the failure mode it exists to prevent is
irreversible.

The adversarial corpus behind this gate is a permanent test suite. Every near-miss
found in practice becomes a new case in it.

## Draft and publish

```bash
kns promote draft concepts/hot-index-reload.md --to team-platform
kns promote publish --confirm
```

The draft is a curated copy, not a mirror of the private note, and it carries
provenance frontmatter: where it came from, who promoted it, who owns it, and when it
must be reviewed again. Publishing opens a pull request in the zone repository. It
never pushes to a default branch and never force-pushes, so review and audit come from
the repository rather than from code KNS would otherwise have to write.

## Revoke and review

`kns promote revoke` clears the origin pointer and opens a removal pull request.
`kns review` finds promoted documents that are past their review date or have lost
their owner, and opens either a renewal or a demotion.

Shared-zone rot is what kills precision in a shared index. Ranking already penalizes
stale, unowned documents, so quality degrades gracefully — but the sweep is what
actually removes them.
