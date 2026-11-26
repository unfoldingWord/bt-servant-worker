# Verbatim relay tokens (#462)

Contract for MCP server authors and worker maintainers. Describes the worker as
implemented in `src/services/claude/relay.ts` and the relay wiring in
`src/services/claude/orchestrator.ts`.

## Publishing blocks

Place blocks on the **top-level** `_meta["bt/relay"]` of an MCP tool result.
The value must be an array of `{ id, text }` objects. Other `_meta` fields are
ignored for relay. Invalid items are dropped and counted under
`relay_invalid_block`.

```json
{
  "content": [{ "type": "text", "text": "…" }],
  "_meta": {
    "bt/relay": [{ "id": "obs-en-01-05-observation", "text": "- Observation Q1\n- Observation Q2" }]
  }
}
```

## Ids and tokens

| Rule                   | Value                     |
| ---------------------- | ------------------------- |
| Id pattern             | `^[A-Za-z0-9._-]{1,128}$` |
| Token the model writes | exactly `{{relay:<id>}}`  |

Anything that is not that exact token (wrong spelling, spaces, missing `}}`,
extra characters inside the braces) is left as written. Cut tokens at end of a
text block (`{{relay:` / `{{relay:partial`) are removed.

## Who is trusted

Only servers listed in `RELAY_SERVER_IDS` (comma-separated env var; whitespace
trimmed) may contribute blocks. Relay is **active for a turn** when:

1. that list is non-empty, and
2. the turn’s tool catalog includes at least one tool from a listed server.

Activation is per **org catalog**, not per chat mode. When inactive, no filter
is created: `progress`, `responses`, and `tool_result` bytes are unchanged,
including text that happens to contain `{{relay:…}}`.

## Note on the tool result

After a round’s tool calls finish, accepted ids for each call are announced by
appending `formatRelayNote(ids)` to that call’s `tool_result` content (today
always a JSON string). Exact text:

```
\n\n[Relay blocks from this tool call. To show one exactly, write its token: {{relay:<id1>}} {{relay:<id2>}} …. Do not retype this text. These ids work only in this turn.]
```

Ids in the note are only those registered from that tool call (or from host
calls nested under that `execute_code`).

## Limits

| Cap               | Scope                                            |
| ----------------- | ------------------------------------------------ |
| 200 blocks        | per turn                                         |
| 64 KiB total text | per turn (UTF-8 byte length of registered texts) |

These caps limit what is **registered**, not how often an id may expand. Within
one text block an id expands at most once (`relay_repeated_id` if written again).
The same id may expand again in another text block or a later round. The first
registered text for an id wins (`relay_id_conflict` if a later block disagrees).
Blocks from a sandbox host call that finishes after the `execute_code` timeout
are discarded (`relay_late_block`); their ids are never registered or noted.

## What users and clients see

| Surface                           | Behavior                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `progress`                        | Expanded text (a block may arrive as one larger chunk after buffering a token prefix) |
| `responses`                       | Expanded text; raw tokens stay in `ctx.messages`                                      |
| History / TTS / webhooks          | Same expanded strings; no new event types or fields                                   |
| Unknown / repeated / cut tokens   | Removed (empty substitution)                                                          |
| Final answer only unusable tokens | Localized `notice_relay_empty` (streamed and kept in `responses`)                     |

## Log events (`relay_*`)

| Event                   | Meaning                                                                        |
| ----------------------- | ------------------------------------------------------------------------------ |
| `relay_invalid_block`   | One or more `_meta["bt/relay"]` items failed shape/id checks (`dropped` count) |
| `relay_late_block`      | Block arrived after its collector closed (late host call)                      |
| `relay_id_conflict`     | Same id registered twice with different text; first wins                       |
| `relay_limit_exceeded`  | Block rejected: 200 ids or 64 KiB already reached                              |
| `relay_unknown_id`      | Token id was not in the turn registry                                          |
| `relay_repeated_id`     | Same id used twice inside one text block                                       |
| `relay_truncated_token` | Incomplete `{{relay:…` at end of a text block (removed)                        |
| `relay_empty_answer`    | Final round’s raw text was non-blank but expanded to nothing; notice delivered |

## Related

- Worker env: `RELAY_SERVER_IDS` in `wrangler.toml` (`[vars]` and staging).
- MCP budget `_meta` fields: [mcp-integration-guidelines.md](./mcp-integration-guidelines.md).
