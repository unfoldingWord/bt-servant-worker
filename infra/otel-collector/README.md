# OpenTelemetry Collector (fly.io)

The telemetry pipe. One bearer-authed OTLP/HTTP receiver → redact + batch →
**OpenObserve** (all signals) + **InfluxDB 3 via door43** (metrics fan-out).
Kept as a collector (not worker→sink direct) so sinks are added/changed as a
collector-only change. See [`../README.md`](../README.md) for the big picture.

## Two apps, one config

| App                              | fly config      | door43 bucket        | GitHub environment |
| -------------------------------- | --------------- | -------------------- | ------------------ |
| `bt-servant-otel-collector`      | `fly.toml`      | `bt-servant-staging` | `staging`          |
| `bt-servant-otel-collector-prod` | `fly.prod.toml` | `bt-servant`         | `production`       |

Both deploy the **same** `otel-collector-config.yaml` from the same pinned image. The two fly
configs differ only in `app` and `[env] INFLUX_BUCKET`, and that pairing is asserted by
[`assert-collector-invariants.py`](../../.github/scripts/assert-collector-invariants.py):
adding a third collector app means adding it to that script's `APP_BUCKETS` map, in a PR.

A swapped bucket is worth a gate because it does not fail — door43's proxy accepts any
token↔bucket pair that matches, so the mistake shows up as staging traffic quietly polluting
the production metric series.

Everything below is written for staging. For production, substitute `fly.prod.toml` and its
app name; `fly` subcommands take `--config fly.prod.toml`.

## Deploy

```bash
# from infra/otel-collector/
fly launch --no-deploy            # once, to create the app (edit fly.toml app/region first)

# Secrets — the worker→collector shared secret + the OpenObserve credentials.
# Generate the shared secret ONCE and SAVE IT: the worker must send the SAME value as its
# OTEL_COLLECTOR_TOKEN, and Fly secrets are write-only (you can't read it back later).
OTEL_INGEST_TOKEN="$(openssl rand -hex 32)"
echo "Ingest token (also set on the worker as OTEL_COLLECTOR_TOKEN): $OTEL_INGEST_TOKEN"

# O2_AUTH carries the OpenObserve ingestion token (from its UI), NOT the OTEL_INGEST_TOKEN above.
# INFLUX_TOKEN is the door43-issued token. It must be the token mapped to the bucket this app
# declares in fly.toml [env] — their Nginx validates the pair and rejects a mismatch.
fly secrets set \
  OTEL_INGEST_TOKEN="$OTEL_INGEST_TOKEN" \
  O2_ENDPOINT="https://bt-servant-openobserve.fly.dev/api/default" \
  O2_AUTH="Basic $(printf '%s' 'you@example.com:INGEST_TOKEN' | base64)" \
  INFLUX_TOKEN="<door43 apiv3_… token for this app's bucket>"
```

**Do not set `INFLUX_BUCKET` as a secret.** It is a bucket name, not a credential, and it
lives in each app's `fly.toml [env]` (`bt-servant-staging` for staging, `bt-servant` for
prod). A fly secret **takes precedence over `[env]`**, so setting one here overrides the
reviewed value in git while `fly secrets list` shows only a digest — restoring exactly the
invisible mapping that move eliminated. Clear a leftover with
`flyctl secrets unset --app <app> INFLUX_BUCKET`.

**Then let CI deploy it. Never run `fly deploy` from a laptop — including the first
deployment.** Config changes go PR → review → merge → [the workflow](#cicd) deploys. That is
the whole point of the CI/CD gate (#324 item 1).

**There is no bootstrap exception**, because there is no chicken-and-egg problem to solve:
`fly launch --no-deploy` above already created the app, so the full first-deploy path is

1. set the app's secrets (above),
2. mint its app-scoped deploy token and store it as `FLY_API_TOKEN` (for a prod app: on the
   `production` GitHub environment),
3. set the `FLY_PROD_COLLECTOR_APP` repo variable,
4. land a commit on `main` — the workflow performs the first deployment, gates included.

### Break-glass only

If a real incident makes waiting for CI untenable, run **both gates locally first** — they are
the reason the boundary exists, and skipping them is how you ship a crash-looping config (the
M0 lesson) or silently undo the `user_id` deletion:

```bash
# 1. Same image tag CI uses, from the Dockerfile — not :latest.
docker run --rm -v "$PWD:/cfg:ro" \
  -e OTEL_INGEST_TOKEN=x -e O2_ENDPOINT=https://x.invalid/api/default -e O2_AUTH=x \
  -e INFLUX_TOKEN=x -e INFLUX_BUCKET=x \
  otel/opentelemetry-collector-contrib:0.157.0 validate --config /cfg/otel-collector-config.yaml

# 2. The privacy + parameterization invariants.
python3 ../../.github/scripts/assert-collector-invariants.py otel-collector-config.yaml

# 3. Only if both pass — and name the config explicitly, since `fly deploy` defaults to
#    fly.toml and would quietly ship STAGING's app and bucket while you meant prod.
fly deploy --config fly.toml      --build-arg OTELCOL_VERSION=0.157.0   # staging
fly deploy --config fly.prod.toml --build-arg OTELCOL_VERSION=0.157.0   # production
```

Then land the identical config through a PR **immediately**, so the deployed state and `main`
cannot silently disagree.

### Required secrets

The config dereferences five `${env:…}` values. Four are secrets and **every one is
mandatory on every collector app**; the fifth, `INFLUX_BUCKET`, comes from `fly.toml [env]`.

| Value               | Where it lives   | What it is                                                  |
| ------------------- | ---------------- | ----------------------------------------------------------- |
| `OTEL_INGEST_TOKEN` | fly secret       | Shared secret the worker sends as `Authorization: Bearer …` |
| `O2_ENDPOINT`       | fly secret       | OpenObserve org base URL                                    |
| `O2_AUTH`           | fly secret       | `Basic <base64(user:token)>` for OpenObserve                |
| `INFLUX_TOKEN`      | fly secret       | door43-issued write token for this app's bucket             |
| `INFLUX_BUCKET`     | `fly.toml [env]` | door43 bucket — the one value that differs per environment  |

> **Any of these fails silently if you forget it.** An unset `${env:…}` resolves to an empty
> string and `otelcol validate` still exits 0 — the collector boots healthy and, in
> `INFLUX_BUCKET`'s case, writes every metric to `bucket=""`. Neither half can be caught by
> reading the config alone, so the two are checked separately:
> [`check-collector-secrets.sh`](../../.github/scripts/check-collector-secrets.sh) queries the
> live fly app for the four secrets before shipping, and
> [`assert-collector-invariants.py`](../../.github/scripts/assert-collector-invariants.py)
> asserts the bucket in git. The pre-flight also **fails the deploy if `INFLUX_BUCKET` exists
> as a secret on the app**, because a fly secret takes precedence over `[env]` — so a leftover
> would make the reviewed value in git dead code while `secrets list` showed only a digest.
> Setting that secret is not a way to override the bucket; it is a way to hide it.

## CI/CD

[`.github/workflows/deploy-collector.yml`](../../.github/workflows/deploy-collector.yml) owns
this directory. Nothing here is in the Worker bundle, so the main `CI` / `Deploy` workflows
ignore it entirely.

- **On PRs** that touch this directory — `otelcol validate` against the exact image tag
  pinned in the `Dockerfile`, then
  [`assert-collector-invariants.py`](../../.github/scripts/assert-collector-invariants.py),
  which parses the YAML and both fly configs and asserts exactly: the exporter bucket is
  `${env:INFLUX_BUCKET}`, every collector app declares the bucket its environment is
  supposed to write to, there is exactly one `user_id` action and it is `delete` on a
  processor every pipeline runs, and no pipeline exports to `debug`. `validate` type-checks
  the config but has no opinion on which values are load-bearing, so it catches none of
  these. Then [both gates' self-tests](../../.github/scripts/tests/) run — the invariant
  checker against fixtures it must reject, and the secrets pre-flight against a stubbed
  `flyctl` (so it needs no credentials) in both directions: required-secret-missing and
  banned-secret-present. A gate that has quietly stopped asserting still reports green,
  which reads as proof.
- **On push to `main` only** — pre-flight the fly secrets, then `flyctl deploy --remote-only`.
  Deploy jobs are pinned to `refs/heads/main`, so a `workflow_dispatch` from another branch
  cannot ship an unmerged ref, and each is serialized on a per-app concurrency group.

Requires a `FLY_API_TOKEN` secret — an **app-scoped Fly deploy token**, not an org-wide one,
so a CI leak cannot reach other apps. There are two of them under that one name: the repo-level
secret deploys staging, and the `production` GitHub environment carries a different value for
the prod app. The jobs' `environment:` declarations are what pick between them.

The production job stays **skipped** until the repo variable `FLY_PROD_COLLECTOR_APP` is set
(see `docs/plans/production-otel.md` B3 step 1). That variable is only an **enable switch** —
the app name and its config come from `fly.prod.toml`, which is what the job actually deploys,
and the job fails if the two names disagree rather than deploying to whichever one won.

Three things are version-pinned on purpose, because each one ends up holding a credential or
gating a deploy — bump them deliberately, never to "latest":

| Pin                   | Where                              | Why                                                                                   |
| --------------------- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| Collector image       | `Dockerfile` `ARG OTELCOL_VERSION` | What CI validates against must be what ships                                          |
| `setup-flyctl` action | full commit SHA                    | A mutable tag is a path to `FLY_API_TOKEN`                                            |
| `flyctl` CLI          | the action's `version:` input      | Its default is `latest`; pinning the action alone still installs an unreviewed binary |

### InfluxDB sink notes

- Smoke-test the token↔bucket pair first with [`tools/send_metrics.sh`](../../tools/send_metrics.sh)
  (`./tools/send_metrics.sh <bucket>` — HTTP 204 = good). Its trace-side companion is
  [`tools/send_trace.sh`](../../tools/send_trace.sh), which proves the OpenObserve leg.
- The bucket **auto-creates on the first write** with infinite retention — ask infra to set
  the retention period after it exists.
- Verify in InfluxDB 3 Explorer: measurements arrive named after each OTel metric
  (`requests_total`, `claude_fetch_duration_ms`, …) with our bounded labels as tags.

`OTEL_INGEST_TOKEN` is the value the worker must send. Store the **same** string as the
worker's `OTEL_COLLECTOR_TOKEN` secret (`wrangler secret put OTEL_COLLECTOR_TOKEN`).

## Prove it

```bash
# 1. Receiver up + bearer auth enforcing: must be 401.
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://bt-servant-otel-collector.fly.dev/v1/traces \
  -H 'Content-Type: application/json' -d '{"resourceSpans":[]}'

# 2. Startup line on every machine.
fly logs --app bt-servant-otel-collector   # "Everything is ready. Begin running and processing data."

# 3. A REAL span, end to end — prompts for the ingest token.
./tools/send_trace.sh bt-servant-otel-collector.fly.dev
```

Then query the OpenObserve **traces** stream for the `smoke_marker` step 3 prints.

**Do not prove the success path with an empty batch.** `{"resourceSpans":[]}` returns 200 while
creating no span, so it tests the receiver and nothing downstream — the collector→sink hop
stays unproven until real traffic arrives. That is why `send_trace.sh` exists, and why a 2xx
from it is still not the finish line: the record showing up in OpenObserve is.

## Staged bring-up

Prove one hop at a time, **without ever editing the pipelines**. The historical version of
this runbook said to trim each pipeline to `[debug]` and redeploy; that is no longer possible
and must not be attempted:
`assert-collector-invariants.py` rejects `debug` in any pipeline, every deploy job
`needs: [validate]`, and the plan explicitly forbids working around it with a laptop
`fly deploy` — the anti-pattern the CI/CD gate exists to prevent. Use the steps in
[Prove it](#prove-it) instead; each proves strictly more than the `debug` stage it replaces:

| Hop to prove             | How                                                                     |
| ------------------------ | ----------------------------------------------------------------------- |
| Process up + bearer auth | unauthenticated `POST /v1/traces` returns **401**                       |
| Config loaded, no crash  | `fly logs` → `Everything is ready. Begin running and processing data.`  |
| Receiver accepts a span  | `./tools/send_trace.sh <host>` returns 2xx                              |
| **Collector → sink**     | that span's `smoke_marker` is findable in the OpenObserve traces stream |
| Metrics → InfluxDB       | `./tools/send_metrics.sh <bucket>` (HTTP 204)                           |

`debug` stays **defined but wired into no pipeline** — `verbosity: detailed` is far too
expensive under real traffic, and `send_trace.sh` + a queryable sink beat reading it out of
stdout anyway. If you ever genuinely need record-level stdout, the auditable route is a
reviewed PR that relaxes the assertion and wires the exporter **in the same diff**, shipped
through the normal workflow, then a second PR reverting it — not a local edit.

To add a second sink later: add its exporter block, append it to each pipeline's `exporters:`
list, and let the workflow deploy it — the worker is never touched.

## Notes

- fly terminates TLS on :443 and proxies to the collector's `internal_port = 4318`.
- `auto_stop_machines = "off"` + `min_machines_running = 1`: a telemetry pipe should never
  cold-start away and drop the worker's export.
- Redaction here is **defense-in-depth**; the worker still redacts at source.
