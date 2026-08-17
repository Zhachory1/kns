# ADR 0004: Promotion publishes only through a pull request

**Status:** accepted (0.1.0)

## Context

Promotion moves content across a privacy boundary, and it is the one operation here
that cannot be undone by deleting a file: once content is in a shared repository's
history, it is out. The design needed an approval step, an audit trail, and a way to
reverse a mistake.

## Decision

`kns promote publish` creates a branch, commits the drafted file by explicit path,
pushes, and opens a pull request with `gh`. It never pushes to a default branch and
never force-pushes. `--confirm` is mandatory. The sanitizer runs again immediately
before the commit.

## Consequences

Approval, audit, and revert all come from the repository. A revert is a demotion, and
the history says who promoted what and what a reviewer said — none of which this
project had to build.

There are two humans in the path by construction: the person who runs the command and
the person who reviews the pull request. For an irreversible operation that is the
right ratio, and it is why there is no `--yes` and no promotion tool exposed over MCP.

The cost is a dependency on `gh` and a workflow that assumes a forge. A zone hosted
somewhere without pull requests would need a different publish adapter; `publish()`
takes its command runner by injection, which is where that would go.

Staging by explicit path rather than `git add -A` matters more than it looks: the zone
checkout is a working directory, and a sweep would quietly promote whatever else was
sitting in it.

## Alternatives rejected

- **Direct commit and push.** No review, and a mistake is already in history.
- **An `--auto-approve` flag.** An override that exists will be used, and this is the
  one operation where the failure is permanent.
