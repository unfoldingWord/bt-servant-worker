# OpenObserve (fly.io) — the telemetry sink

Self-hosted, single-binary observability store **and** web UI (traces, logs, metrics,
dashboards, alerting). Operated and queried only by us — governance stays in our hands.

## Two instances

| Instance   | fly app                       | config          | stream storage            | retention fallback |
| ---------- | ----------------------------- | --------------- | ------------------------- | ------------------ |
| Staging    | `bt-servant-openobserve`      | `fly.toml`      | local volume              | 7 days             |
| Production | `bt-servant-openobserve-prod` | `fly.prod.toml` | Cloudflare R2 (`ZO_S3_*`) | 395 days           |

That last column is what a stream gets when it has **no** retention setting of its own — it
is not a cap on the ones that do. See [Retention](#retention). Both instances keep a durable
volume regardless of where stream data lives; see [The volume](#the-volume).

Separate instances, not two streams on one box: the OSS build reports `rbac_enabled: false`,
so there is no per-stream scoping and every login on an instance can read all of it.

**Neither instance has CI/CD yet** — unlike the collector, this directory is hand-deployed,
so a change to either `fly.toml` does nothing until someone runs `fly deploy`. That is
[`docs/plans/production-otel.md`](../../docs/plans/production-otel.md) **B2.5**, and it must
land **before** B3 provisions the production app: otherwise prod OpenObserve gets
bootstrapped by a laptop `fly deploy`, which is exactly what the CI/CD boundary exists to
prevent, and its deployed state starts out unreconcilable with `main`.

## Deploy

```bash
# from infra/openobserve/
# Staging uses fly.toml (the default); for production pass --config fly.prod.toml to every
# command below, and use the app name from that file.
fly launch --no-deploy                       # edit fly.toml app/region first
fly volumes create openobserve_data --size 3 # durable metadata — see "The volume" below;
                                             # prod wants --size 10 and snapshots enabled

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

### The volume

**Moving stream data to R2 does not make `/data` disposable.** In local mode `ZO_META_STORE`
defaults to `sqlite`, and `ZO_DATA_DB_DIR` — under `ZO_DATA_DIR` — holds `metadata.sqlite`:
users, orgs, stream settings (including the retention values below), and the **`file_list`
index**, which is what maps a query to the parquet objects sitting in R2.

So the failure mode of losing this volume is not "cold cache". It is:

- every login, org, and stream setting on the instance, gone; and
- **every byte in R2 orphaned** — the objects are still there and still billed, and nothing
  can find them, because the index that knew about them was the thing you lost.

Treat it as the durable component it is: take fly volume snapshots, and treat restore as a
real procedure rather than an assumption. Moving the meta store to an external Postgres
(`ZO_META_STORE=postgres` + `ZO_META_POSTGRES_DSN`) is the alternative if we ever want the
instance itself to be disposable; we are not doing that yet.

### Retention

`ZO_COMPACT_DATA_RETENTION_DAYS` (default **3650** — ten years) is a **fallback, not a
ceiling.** The compactor uses a stream's own `stream_settings.data_retention` whenever that
is greater than zero and only falls back to the env value otherwise — **it does not take the
minimum of the two.**

That distinction is the whole game here, because it means:

- A stream already carrying 3650 **ignores the env var entirely.** This is why staging has
  stayed at ten years, and why setting `ZO_COMPACT_DATA_RETENTION_DAYS = "7"` there does not
  by itself fix the existing streams.
- The env var governs only streams with no setting of their own — in practice, new ones.

So every tier has to be set **on the stream** and then read back:

| Stream    | Target   | Set where                                          |
| --------- | -------- | -------------------------------------------------- |
| `traces`  | 14 days  | per-stream, in the UI — the env var will not do it |
| `logs`    | 30 days  | per-stream, in the UI — the env var will not do it |
| `metrics` | 395 days | per-stream, in the UI (matches the env fallback)   |

The env fallback is set to the longest of the three so that a stream nobody has configured
yet errs toward over-retaining cheap data rather than deleting it. That is a default for the
unconfigured case — it is **not** enforcement of a maximum, and nothing in the config
prevents a stream from being set to ten years. Verify, don't assume:

```bash
# Read back what each stream is ACTUALLY set to — the only proof that matters.
curl -s -u "$O2_USER:$O2_PASS" \
  "https://<instance>.fly.dev/api/default/streams" \
  | jq -r '.list[] | "\(.name)\t\(.stream_type)\tretention=\(.settings.data_retention // "unset -> env fallback")"'
```

## Notes

- Signals arrive from the collector routed by the `stream-name` header
  (`traces`, `logs`); metrics auto-create their own streams.
- `auto_stop_machines = "off"`: the store must stay up to both ingest and serve queries.
