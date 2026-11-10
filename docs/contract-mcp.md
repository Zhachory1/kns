# MCP contract

**Status:** implemented (PR-10). Generated from the tool registry from PR-20 onward.

`kns-mcp` is a local stdio MCP server. It is a drop-in replacement for a single-zone
server such as `zbrain-mcp`: point an agent at it and the whole hierarchy becomes
available with no other configuration change.

```json
{
  "mcpServers": {
    "kns": { "command": "kns-mcp" }
  }
}
```

The zone registry supplies the roots, so tool calls do not accept per-call roots or
filesystem paths. That keeps a prompt-injected tool call from redirecting retrieval at
an arbitrary directory.

## Tools

| Tool | Purpose |
|------|---------|
| `kns.resolve` | Ranked retrieval across zones, with provenance on every hit |
| `kns.get` | Bounded excerpt from a document, addressed by zone and document id |
| `kns.answer` | Cited evidence: snippets with zone, owner, age, and conflict flag |
| `kns.zones` | Visible zones with tier, distance, owner, and TTL |
| `kns.status` | Zone count and cache statistics |

A tool failure is reported in band, with `isError: true` and the standard error
payload, rather than as a JSON-RPC transport error. A caller can tell the difference
between "that query was rejected" and "the server broke", and only the second is worth
retrying blindly.

A test asserts that no tool schema mentions a root, a path, or a command, and that no
tool contains the word `promote`. Those are the two properties that keep a
prompt-injected tool call from redirecting retrieval or publishing anything.

All tools are read-only and bounded. There is no promotion tool: promotion crosses a
privacy boundary and requires a human at a terminal, not an agent with a tool call.

## Wire behavior

Supported methods: `initialize`, `notifications/initialized`, `tools/list`,
`tools/call`. Responses are JSON-RPC 2.0 and tool results use MCP content blocks.

Tool errors set `isError: true` and carry the standard error envelope:

```json
{
  "schemaVersion": 1,
  "error": { "code": "zone_timeout", "message": "...", "nextStep": "..." },
  "partial": true
}
```

## Bounds

| Input | Range |
|-------|-------|
| `limit` | 1–20 |
| `lines` | 1–200 |
| `query` length | 1–1000 characters |

Out-of-range input is rejected with `invalid_request` rather than clamped, so a caller
never silently receives something other than what it asked for.
