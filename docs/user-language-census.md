# User language & country census — methodology

How the bt-servant user population is enumerated and how per-user language and
country are derived. Written up because the enumeration is non-obvious: Durable
Objects are addressed by a one-way hash, so recovering _who_ an object belongs
to took three independent identity sources.

Run against production on 2026-08-05 (worker v2.38.2). **The resulting dataset is
deliberately not committed** — see [Data handling](#data-handling).

## Why this was hard

`env.USER_DO.idFromName("user:{org}:{user_id}")` is one-way. The Cloudflare REST
API can list every object in a namespace, but it returns opaque 64-hex ids that
cannot be reversed to a user id, and before v2.38.0 a DO stored nothing about its
own identity. So the population was _countable_ but not _addressable_: we could
see ~1,200 objects and attribute almost none of them.

Three sources closed the gap.

| Source                                    | Reach                              | Limit                                                                                                                                            |
| ----------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workers Logs (`request_received`)         | user_id + org + client_id          | **7-day retention**, and the telemetry `values` endpoint silently caps at 50 distinct values — enumerate with `query` over daily windows instead |
| R2 audio keys (`audio/{org}/{user_id}/…`) | voice users, any era               | voice users only                                                                                                                                 |
| `CHAT_ORG_KV`                             | 114 email identities (web / shema) | web users only                                                                                                                                   |

Everything else — the majority — was reachable only after v2.38.0 added
`GET /api/v1/admin/do/{hexId}/snapshot`, which opens any object via
`idFromString` and returns its stored identity plus chat history.

## Enumeration procedure

1. **List objects.** `GET /accounts/{acct}/workers/durable_objects/namespaces/{ns}/objects?limit=1000`,
   cursor-paginated. Prod `UserDO` namespace: `421f00ef2f684985854ce0373355ae8d`.
   Filter to `hasStoredData`.
2. **Snapshot each.** `GET /api/v1/admin/do/{hexId}/snapshot?limit=100` with the
   `ENGINE_API_KEY` bearer token. Returns `{do_id, identity, history}`.
3. **Attribute.** Prefer the DO's own persisted `identity` (present only for turns
   after the v2.38.0 release). Otherwise fingerprint against known identities by
   shared message timestamps — millisecond precision makes a shared timestamp a
   near-certain match.
4. **Detect language** offline from `user_message` text only. Assistant responses
   are excluded; they are model output and would swamp the signal.
5. **Derive country** from the E.164 calling code of phone-based user ids.

> **Gotcha that cost real time:** files written via `jq`/`sort` on Windows carry
> CRLF endings. A trailing `\r` read into a URL makes curl fail with exit 3 and
> HTTP 000 — which looks like a network outage, not a data bug. Pipe id lists
> through `tr -d '\r'` before they reach a request.

## Deriving country

Country comes from the phone number, **not** from `request.cf.country`.

An earlier pass used the Cloudflare edge country and produced a badly misleading
result: over 1,100 requests appeared to originate in Norway and Sweden. Those
were gateway egress locations, not users. For any gateway-relayed client the edge
country describes infrastructure, which is why the worker records `edge_country`
and `user_country` as separate dimensions and never substitutes one for the other.

Phone inference is gated on an allow-list of clients whose `user_id` contract is
genuinely E.164 (`whatsapp`, `signal-gateway`) and **fails closed** — a numeric id
is not evidence of a phone number. The Telegram gateway sends `String(from.id)`, a
numeric _account_ id; read as a dialling code, the real production id `5671505928`
yields calling code 56 and reports the user as Chilean. See
`src/utils/phone-country.ts` and its tests.

## Detection confidence

Every detection carries an evidence grade, computed from sample volume and
agreement rather than from any judgement about which languages look plausible:

| Grade      | Rule                                                           |
| ---------- | -------------------------------------------------------------- |
| `strong`   | ≥5 messages of ≥20 chars, and the winner holds ≥60% of them    |
| `moderate` | 2–4 qualifying messages                                        |
| `weak`     | 0–1 qualifying messages — fell back to the concatenated corpus |

This matters more than it sounds. In the 2026-08-05 run, one language showed 52
users with **zero** strong detections; 50 of the 52 rested on a single short
message. Ranking languages by raw count would have promoted a detector artefact
into a finding. **Rank by the `strong` column, not the total.**

Two known detector limitations, both inherent to short messages rather than to
this pipeline:

- **Indonesian and Malay cannot be reliably separated** at typical message
  length. Treat them as one cluster.
- Regional languages with small training corpora attract false positives from
  short text; they surface almost exclusively as `weak`.

## Data handling

The generated dataset (per-user rows with country, client, and activity dates)
is **not committed to this repository, which is public.** For countries with a
single user, that combination is quasi-identifying, and some are access-sensitive
regions. Only aggregate counts should ever leave a private context, and per-user
rows should not be published at all.

The pipeline emits aggregates only — no message content is written to any output.

## Going forward this is unnecessary

Since v2.38.0 the worker records what this whole procedure reconstructs:

- Each chat turn persists a `StoredIdentity` (`do_name`, org, user_id, client_id,
  chat_type) under the DO's `identity` storage key, so objects become
  self-describing as users return.
- Each turn emits a `chat_turn` log record and a `chat_turns_total` metric
  carrying `response_language`, `user_country`, and `edge_country`.

Country × language is therefore a standing query against the metrics backend,
with no 7-day log-retention ceiling. This document exists to explain the
historical backfill and the traps in it — not as a procedure to repeat.
