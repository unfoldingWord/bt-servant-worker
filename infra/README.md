# Telemetry infrastructure (`infra/`)

Infrastructure-as-code + runbooks for the worker's OpenTelemetry pipe. **Nothing here is
bundled into the Cloudflare Worker** — Wrangler builds only from `src/`. These are
separately deployed services (fly.io) and their configs.

## Architecture

```
                                   ┌────────────────────────────┐
  bt-servant-worker  ──OTLP/HTTP──►│  OpenTelemetry Collector    │
  (one endpoint,      + Bearer     │  (fly.io, TLS via fly)      │
   one secret)        token        │                             │
                                   │  receiver → redact → batch  │
                                   │           │                 │
                                   │           ▼ export          │
                                   └───────────┬────────────────┘
                                               │
                                       ────────▼──────── sink
                                   OpenObserve (fly.io)
                                   self-hosted, our UI
                                   governance = ours
```

**Why a collector at all** (when there's only one sink today)? The worker only ever talks
to the collector — one endpoint, one secret. Everything downstream (which sink(s),
redaction, retry) is a **collector-config-only** change the worker never sees. Adding a
second sink later is: add an exporter block, append it to each pipeline, reload — the
worker is never touched or redeployed.

**Governance.** OpenObserve is operated and queried only by us (fly is just an IaaS host);
the control plane stays in our hands. We still **redact at source** (in the worker) and
again in the collector, so no message content or precise location reaches the sink.
**User identifiers never reach a sink at all:** the worker emits a salted `user_hash`
(HMAC-SHA-256, secret `TELEMETRY_USER_ID_SALT`) for joinability, and the collector
**deletes** the raw `user_id` outright — it is not hashed there, because the collector's
`hash` action is unsalted and therefore reversible for enumerable ids. The
sovereign endgame (owned-hardware Grafana LGTM) is later a collector-config change, nothing
more. (A 3rd-party SaaS sink like Axiom was considered and dropped.)

## Directories

- `otel-collector/` — the collector (fly.io). Start here.
- `openobserve/` — self-hosted OpenObserve store + UI (fly.io), the sink.

## Bring-up order

1. Deploy **OpenObserve** (`openobserve/`). Note its URL + create an ingestion token.
2. Deploy the **collector** (`otel-collector/`) **through its workflow** — never a laptop
   `fly deploy`. Confirm the process is up and enforcing auth: an unauthenticated
   `POST /v1/traces` returns **401**, and `fly logs` shows
   `Everything is ready. Begin running and processing data.`
3. Run `./tools/send_trace.sh <collector-host>` — one real OTLP span with a unique
   `smoke_marker` — then find that marker in the OpenObserve **traces** stream. This proves
   collector → sink, which a 2xx alone does not.
   **This is the Definition of Done for a new environment's pipe.**
4. Only then point the worker's `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_COLLECTOR_TOKEN` at the
   collector — that is the switch that starts real traffic flowing.

> **Do not wire the `debug` exporter to do any of this.**
> `assert-collector-invariants.py` rejects `debug` in any pipeline and every deploy job
> depends on that gate, so such a config cannot ship. Step 3 proves strictly more than
> reading records out of stdout ever did. See
> [`otel-collector/README.md`](otel-collector/README.md) for the reviewed exception route if
> stdout is ever genuinely required.

All secrets live in the respective fly app (`fly secrets set ...`), never in git — except
values that are not actually secret; see the `INFLUX_BUCKET` discussion in
`docs/plans/production-otel.md` B2.
