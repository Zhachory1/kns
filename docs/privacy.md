# Privacy

**Status:** skeleton. Completed alongside the sanitizer (PR-13), the cache (PR-09),
and demand signals (PR-17).

## What stays on your machine

Everything, by default. Your `USER` zone is a local index over your own files. KNS
adds routing on top of it; it does not add a place for your notes to go.

Shared zones arrive as git clones. Resolution talks to local processes over stdio, so
a query never leaves the machine — not to a zone, not to a service, not to telemetry.

## What can leave, and how

Exactly one path: promotion, described in [promotion](promotion.md). It requires a
command you type, a sanitizer that fails closed, and a pull request someone reviews.
There is no automatic promotion, no background sync of private content, and no agent
tool that can publish.

## Data at rest

| Location | Contents | Sensitivity |
|----------|----------|-------------|
| `~/.kns/zones.json` | Zone names, paths, owners | Low, but reveals your team structure |
| `~/.kns/cache.sqlite` | Snippets from shared zones, demand counters | Treat as private |
| Zone clones | Whatever the shared repository contains | Per repository access |

Both KNS state files are gitignored. `kns cache purge` clears the cache.

## Demand signals

Knowing which documents teammates keep retrieving is genuinely useful for deciding
what to promote. It is also a surveillance mechanism if built carelessly, so it ships
disabled and is constrained by construction:

- Counters are local unless you explicitly export them.
- The export contains no query text and no user identity — only a document, a week,
  and a bucketed count, under a rotating pseudonymous reporter id.
- The aggregator drops any document reported by fewer than `kMin` distinct reporters,
  so a signal can never be traced to one person.

If that still sounds like too much, leave it off. Everything else works without it.

## What KNS deliberately does not do

- No network calls during install, and no post-install hooks or bootstrap scripts.
- No fetching the zone registry from a remote source.
- No remote query transport in 0.1.0.
- No telemetry of any kind, opt-in or otherwise, beyond the local counters above.
