# OpenTelemetry Collector (fly.io)

The telemetry pipe. One bearer-authed OTLP/HTTP receiver → redact + batch →
**OpenObserve** (all signals) + **InfluxDB 3 via door43** (metrics fan-out).
Kept as a collector (not worker→sink direct) so sinks are added/changed as a
collector-only change. See [`../README.md`](../README.md) for the big picture.

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
# INFLUX_TOKEN is the door43-issued token; INFLUX_BUCKET is the bucket their Nginx maps that
# token to — the two must be a matched pair, or writes are rejected at the proxy.
fly secrets set \
  OTEL_INGEST_TOKEN="$OTEL_INGEST_TOKEN" \
  O2_ENDPOINT="https://bt-servant-openobserve.fly.dev/api/default" \
  O2_AUTH="Basic $(printf '%s' 'you@example.com:INGEST_TOKEN' | base64)" \
  INFLUX_TOKEN="<door43 apiv3_… token for the bucket below>" \
  INFLUX_BUCKET="bt-servant-staging"   # prod: bt-servant

```

**Then let CI deploy it — do not run `fly deploy` from a laptop.** Config changes go
PR → review → merge → [the workflow](#cicd) deploys, which is the whole point of the CI/CD
gate (#324 item 1). The one legitimate manual use is **bootstrapping a brand-new app** before
its repo variable exists, or a genuine emergency:

```bash
fly deploy --build-arg OTELCOL_VERSION=0.157.0   # bootstrap/emergency only; pin the tag
```

A manual deploy skips `otelcol validate` and `assert-collector-invariants.py`, so it can ship
a crash-looping config (the M0 lesson) or silently undo the `user_id` deletion. If you use it,
land the same config through a PR immediately afterwards so the deployed state and `main`
agree.

### Required secrets

The config dereferences all five; **every one is mandatory on every collector app**.

| Secret              | What it is                                                                       |
| ------------------- | -------------------------------------------------------------------------------- |
| `OTEL_INGEST_TOKEN` | Shared secret the worker sends as `Authorization: Bearer …`                      |
| `O2_ENDPOINT`       | OpenObserve org base URL                                                         |
| `O2_AUTH`           | `Basic <base64(user:token)>` for OpenObserve                                     |
| `INFLUX_TOKEN`      | door43-issued write token                                                        |
| `INFLUX_BUCKET`     | door43 bucket that token maps to — this is what makes one config serve both envs |

> **`INFLUX_BUCKET` fails silently if you forget it.** An unset `${env:…}` resolves to an
> empty string and `otelcol validate` still exits 0 — the collector boots healthy and writes
> every metric to `bucket=""`. That is why the deploy workflow runs
> [`check-collector-secrets.sh`](../../.github/scripts/check-collector-secrets.sh) against the
> live fly app before shipping, rather than trusting `validate` alone.

## CI/CD

[`.github/workflows/deploy-collector.yml`](../../.github/workflows/deploy-collector.yml) owns
this directory. Nothing here is in the Worker bundle, so the main `CI` / `Deploy` workflows
ignore it entirely.

- **On PRs** that touch this directory — `otelcol validate` against the exact image tag
  pinned in the `Dockerfile`, then
  [`assert-collector-invariants.py`](../../.github/scripts/assert-collector-invariants.py),
  which parses the YAML and asserts exactly: the bucket is `${env:INFLUX_BUCKET}`, there is
  exactly one `user_id` action and it is `delete` on a processor every pipeline runs, and no
  pipeline exports to `debug`. `validate` type-checks the config but has no opinion on which
  values are load-bearing, so it catches none of these.
- **On push to `main` only** — pre-flight the fly secrets, then `flyctl deploy --remote-only`.
  Deploy jobs are pinned to `refs/heads/main`, so a `workflow_dispatch` from another branch
  cannot ship an unmerged ref, and each is serialized on a per-app concurrency group.

Requires a `FLY_API_TOKEN` repo secret — an **app-scoped Fly deploy token**, not an org-wide
one, so a CI leak cannot reach other apps. The production job stays **skipped** until the repo
variable `FLY_PROD_COLLECTOR_APP` is set to the prod app's name (see
`docs/plans/production-otel.md` B3 step 1); it then deploys the same config with an `--app`
override, and will need its own token.

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
