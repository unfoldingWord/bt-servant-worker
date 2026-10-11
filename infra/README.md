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
                                   OpenObserve (fly.io)     all signals
                                   self-hosted, our UI
                                   governance = ours
                                               │
                                       ────────▼──────── sink #2 (metrics only)
                                   Grafana Mimir (door43)
                                   delta → cumulative in the collector
```

## Two environments, four apps

Staging and production run **entirely separate** collectors and sinks. Nothing is shared
between the columns below — not the app, not the OpenObserve instance, not the fly deploy
token, not the Mimir org.

| Thing               | Staging                     | Production                       |
| ------------------- | --------------------------- | -------------------------------- |
| Collector fly app   | `bt-servant-otel-collector` | `bt-servant-otel-collector-prod` |
| Collector config    | `otel-collector/fly.toml`   | `otel-collector/fly.prod.toml`   |
| OpenObserve fly app | `bt-servant-openobserve`    | `bt-servant-openobserve-prod`    |
| OpenObserve config  | `openobserve/fly.toml`      | `openobserve/fly.prod.toml`      |
| OpenObserve storage | local volume                | Cloudflare R2 (`ZO_S3_*`)        |
| Mimir org (= user)  | `bt-servant-staging`        | `bt-servant`                     |
| Deploy token        | `FLY_API_TOKEN` (repo)      | `FLY_API_TOKEN` (`production`)   |

**Why two OpenObserve instances rather than one with two streams?** The OSS build reports
`rbac_enabled: false` — there is no per-stream or per-org scoping, so any login on an
instance can read everything on it. Instance separation is the only access control on
offer, so production data gets its own box.

**Why two fly tokens under one name?** Each is app-scoped, so a leak in CI reaches one app
instead of the org. The collector workflow's `environment: staging` / `environment:
production` job declarations are what select between them: GitHub resolves an
environment-scoped secret over a repo-level one, so the same `${{ secrets.FLY_API_TOKEN }}`
expression yields a different token per job. **Those two lines are load-bearing** — deleting
them silently repoints production at the staging token.

Both collector apps run the **same** `otel-collector-config.yaml` from the same pinned
image. The only difference between the two environments is each app's `fly.toml [env]` plus
its own secrets, and `assert-collector-invariants.py` fails the build if an app's declared
Mimir user is not the one the reviewed map assigns it. (door43 maps each username to a fixed
Mimir org, so the username is what selects where metrics land.)

**Why a collector at all?** The worker only ever talks to the collector — one endpoint, one
secret. Everything downstream (which sink(s), redaction, retry, temporality) is a
**collector-config-only** change the worker never sees. The metrics sink has already moved
once this way — InfluxDB 3 → Mimir when door43 retired Influx — without touching or
redeploying the worker. The worker emits DELTA metrics (ephemeral isolates); Mimir expects
CUMULATIVE; the collector's `deltatocumulative` processor bridges the two on the Mimir
pipeline only, while OpenObserve keeps receiving delta as before.

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

Run the bring-up once per environment. Staging is already live; production is
`docs/plans/production-otel.md` B3.

All **secrets** live in the respective fly app (`fly secrets set ...`), never in git. Values
that are not actually secret do not belong there: `MIMIR_USER` is an org identifier and lives
in each app's `fly.toml [env]`, where the user↔environment mapping is diffable and
code-reviewed instead of being a digest in `fly secrets list`.

> **A fly secret of a given name takes precedence over `[env]` of the same name.** Setting
> `MIMIR_USER` as a secret on a collector app does not "also" set it — it overrides the
> reviewed value in git and nothing anywhere reports the difference. The deploy pre-flight
> fails the deploy when it finds one.
