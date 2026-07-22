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
again in the collector, so no message content or precise location reaches the sink. The
sovereign endgame (owned-hardware Grafana LGTM) is later a collector-config change, nothing
more. (A 3rd-party SaaS sink like Axiom was considered and dropped.)

## Directories

- `otel-collector/` — the collector (fly.io). Start here.
- `openobserve/` — self-hosted OpenObserve store + UI (fly.io), the sink.

## Bring-up order

1. Deploy **OpenObserve** (`openobserve/`). Note its URL + create an ingestion token.
2. Deploy the **collector** (`otel-collector/`) with `debug` exporter only → confirm it
   starts and authenticates.
3. Point the worker's `OTEL_EXPORTER_OTLP_ENDPOINT` at the collector, send a request,
   watch it appear in the collector `debug` logs (proves worker→collector + bearer auth).
4. Enable the OpenObserve exporters → confirm data in the OpenObserve UI.
   **This is the M0 Definition of Done.**

All secrets live in the respective fly app (`fly secrets set ...`), never in git.
