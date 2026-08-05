# OpenObserve (fly.io) — the telemetry sink

Self-hosted, single-binary observability store **and** web UI (traces, logs, metrics,
dashboards, alerting). Operated and queried only by us — governance stays in our hands.

## Two instances

| Instance   | fly app                       | config          | stream storage            | retention fallback |
| ---------- | ----------------------------- | --------------- | ------------------------- | ------------------ |
| Staging    | `bt-servant-openobserve`      | `fly.toml`      | local volume              | 7 days             |
| Production | `bt-servant-openobserve-prod` | `fly.prod.toml` | Cloudflare R2 (`ZO_S3_*`) | 1825 days (5 yrs)  |

That last column is what a stream gets when it has **no** retention setting of its own — it
is not a cap on the ones that do. See [Retention](#retention). Both instances keep a durable
volume regardless of where stream data lives; see [The volume](#the-volume).

Separate instances, not two streams on one box: the OSS build reports `rbac_enabled: false`,
so there is no per-stream scoping and every login on an instance can read all of it.

## CI/CD

[`.github/workflows/deploy-openobserve.yml`](../../.github/workflows/deploy-openobserve.yml)
is this directory's entire CI/CD (the main CI/Deploy workflows never touch it), mirroring
the collector's. **Deploys happen on merge to `main`** for any change under
`infra/openobserve/**`, the workflow itself, or `.github/scripts/**` — never by a laptop
`fly deploy`, and there is no bootstrap exception: even a brand-new app's first deploy goes
through the workflow (provisioning with `fly launch --no-deploy` creates the app without
deploying it).

- **validate** (every PR): parses `ARG OPENOBSERVE_VERSION` from the Dockerfile (the deploy
  jobs pass it as `--build-arg`, so the pin has one source of truth), asserts
  `fly.prod.toml` keeps `ZO_LOCAL_MODE_STORAGE = "s3"` (see
  [Production extras](#production-extras)), and runs the secrets pre-flight's self-test.
  There is no `otelcol validate` equivalent — OpenObserve is configured entirely by `[env]`
  and secrets, so the pre-flight and the pin parse are what this workflow gates on.
- **deploy jobs**: [`check-openobserve-secrets.sh`](../../.github/scripts/check-openobserve-secrets.sh)
  pre-flights each app before deploying — required secrets present (per-app list; prod adds
  the `ZO_S3_*` trio), and **no fly secret shadowing an `[env]` key** (a fly secret silently
  takes precedence over `[env]`, the `INFLUX_BUCKET` lesson from #340 — here the banned
  list is parsed from the toml so it cannot drift).
- **Tokens**: both deploy jobs read `FLY_OPENOBSERVE_API_TOKEN` — app-scoped deploy tokens,
  not the collector's `FLY_API_TOKEN`. Staging's lives at repo level; prod's on the
  `production` GitHub environment, which wins over the repo-level name for that job.
- **Prod gate**: the production job is skipped until the `FLY_PROD_OPENOBSERVE_APP` repo
  variable is set to the app name in `fly.prod.toml` (B3 step 1). The variable only enables
  the job — the app name always comes from `fly.prod.toml`, and the job fails if they
  disagree.

**A deploy restarts a stateful app.** Unlike the stateless collector pipe, rolling this
machine briefly interrupts ingest and queries; the collector's exporter queue absorbs the
ingest gap. That is the accepted cost of deploy-on-merge — the alternative is `main` and
the running sink drifting apart, which is how staging's retention sat wrong for weeks.

## Provisioning (once per instance)

```bash
# from infra/openobserve/
# Staging uses fly.toml (the default); for production pass --config fly.prod.toml to every
# command below, and use the app name from that file.
fly launch --no-deploy                       # creates the app only — the WORKFLOW deploys
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

# Then mint the app-scoped deploy token CI uses (see CI/CD above) and let the workflow
# deploy — do NOT run `fly deploy` from a laptop:
fly tokens create deploy --app <app-name>
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

**Production runs one tier, via the fallback** (decided 2026-08-05):

| Instance     | Streams                   | Retention               | How                                |
| ------------ | ------------------------- | ----------------------- | ---------------------------------- |
| `production` | all, incl. new ones       | **1825 days (5 years)** | `[env]` fallback; no stream is set |
| `staging`    | `traces`,`logs`,`metrics` | 3650 days (unchanged)   | per-stream values set before B2    |

The earlier three-tier plan (traces 14d / logs 30d / metrics 395d) was dropped because
**`metrics` is not one stream**: OpenObserve splits every OTel metric into its own stream and
fans each histogram into `_bucket/_count/_max/_min/_sum` — about 28 streams on day one, and a
new one every time a metric is added. Per-stream retention would have to be re-applied
forever, while the fallback covers new streams automatically. At measured volume
(~0.51 KB/span compressed) five years is single-digit GB, so cost was not the deciding factor.

> **Editing the fallback is destructive.** Since no production stream carries its own value,
> this variable is evaluated live by the compactor rather than stamped at write time.
> Lowering it retroactively deletes everything older than the new value, across every
> stream, on the next compaction — silently, with no alert and no archive.

Nothing in the config prevents a stream from being set to ten years, which is how staging
ended up there. Verify, don't assume:

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
