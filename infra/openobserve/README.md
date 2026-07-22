# OpenObserve (fly.io) — the telemetry sink

Self-hosted, single-binary observability store **and** web UI (traces, logs, metrics,
dashboards, alerting). Operated and queried only by us — governance stays in our hands.

## Deploy

```bash
# from infra/openobserve/
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

## Notes

- Signals arrive from the collector routed by the `stream-name` header
  (`traces`, `logs`); metrics auto-create their own streams.
- Local-disk storage (`ZO_DATA_DIR=/data`) is fine at current volume. For scale, move to
  S3-compatible storage via `ZO_S3_*` — cheapest long-term option and no schema change.
- `auto_stop_machines = "off"`: the store must stay up to both ingest and serve queries.
