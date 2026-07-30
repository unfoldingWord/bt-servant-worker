# OpenObserve (fly.io) — the telemetry sink

Self-hosted, single-binary observability store **and** web UI (traces, logs, metrics,
dashboards, alerting). Operated and queried only by us — governance stays in our hands.

## Two instances

| Instance   | fly app                       | config          | stream storage            | retention ceiling |
| ---------- | ----------------------------- | --------------- | ------------------------- | ----------------- |
| Staging    | `bt-servant-openobserve`      | `fly.toml`      | local volume              | 7 days            |
| Production | `bt-servant-openobserve-prod` | `fly.prod.toml` | Cloudflare R2 (`ZO_S3_*`) | 395 days          |

Separate instances, not two streams on one box: the OSS build reports `rbac_enabled: false`,
so there is no per-stream scoping and every login on an instance can read all of it.

**Neither instance has CI/CD** — unlike the collector, this directory is hand-deployed, so a
change to either `fly.toml` does nothing until someone runs `fly deploy`. Known gap.

## Deploy

```bash
# from infra/openobserve/
# Staging uses fly.toml (the default); for production pass --config fly.prod.toml to every
# command below, and use the app name from that file.
fly launch --no-deploy                       # edit fly.toml app/region first
fly volumes create openobserve_data --size 3 # persistent storage for /data

# Root user is created on first boot. Choose a password and SAVE IT first — Fly secrets are
# write-only, so a value you can't read back locks you out of the UI login below.
# NOTE: OpenObserve >= v0.91.0 enforces a password policy (>=8 chars, with at least one
# lowercase, uppercase, digit, and special char). A bare `openssl rand -hex` is hex-only and
# crash-loops the app on boot ("ZO_ROOT_USER_PASSWORD is too weak"), so append a compliant suffix.
ZO_ROOT_USER_PASSWORD="$(openssl rand -hex 20)Aa1@"
echo "OpenObserve root password (store in your password manager): $ZO_ROOT_USER_PASSWORD"
fly secrets set \
  ZO_ROOT_USER_EMAIL="you@example.com" \
  ZO_ROOT_USER_PASSWORD="$ZO_ROOT_USER_PASSWORD"

fly deploy --build-arg OPENOBSERVE_VERSION=v0.91.0   # pin a stable tag; see Dockerfile
```

Open `https://bt-servant-openobserve.fly.dev` and log in with those credentials.

## Wire it to the collector

1. In the UI: **Data Sources / Ingestion** → copy the org's ingestion token (or use the
   root user's token).
2. Build the collector's `O2_AUTH` = `Basic base64("<email>:<ingest-token>")` and set the
   collector's `O2_ENDPOINT` = `https://bt-servant-openobserve.fly.dev/api/default`
   (`default` = the org name; change if you created another).
3. Set both as fly secrets on the **collector** app (see `../otel-collector/README.md`).

## Production extras

The prod instance needs three secrets staging does not, because its stream data lives in
Cloudflare R2 rather than on the volume:

```bash
fly secrets set --config fly.prod.toml \
  ZO_S3_SERVER_URL="https://<cloudflare-account-id>.r2.cloudflarestorage.com" \
  ZO_S3_ACCESS_KEY="<R2 access key id>" \
  ZO_S3_SECRET_KEY="<R2 secret access key>"
```

The bucket name, region, and provider are **not** secrets and live in `fly.prod.toml [env]`.
The server URL is a secret only because it embeds the Cloudflare account id.

- R2 is S3-compatible: `ZO_S3_PROVIDER=s3` (there is no `r2` value) and `ZO_S3_REGION_NAME=auto`.
- **`ZO_LOCAL_MODE_STORAGE=s3` is the switch.** Without it the other `ZO_S3_*` values are
  read and ignored, and everything keeps landing on the local volume — which looks fine
  until the volume fills.
- The volume stays mounted either way; on prod it is WAL + query cache, not the retention
  boundary.

### Retention

`ZO_COMPACT_DATA_RETENTION_DAYS` is a single global value (default **3650** — ten years,
which is how staging ended up effectively unbounded). Per-signal tiers are **per-stream
overrides set in the UI**, so the env var is deliberately the _longest_ tier and the shorter
ones are applied on top:

| Stream    | Target   | Set where                     |
| --------- | -------- | ----------------------------- |
| `traces`  | 14 days  | per-stream override in the UI |
| `logs`    | 30 days  | per-stream override in the UI |
| `metrics` | 395 days | the `[env]` ceiling           |

Set that way round so a missed override over-retains cheap trace data rather than silently
deleting the metrics history, which is the one signal here that cannot be reconstructed.

## Notes

- Signals arrive from the collector routed by the `stream-name` header
  (`traces`, `logs`); metrics auto-create their own streams.
- `auto_stop_machines = "off"`: the store must stay up to both ingest and serve queries.
