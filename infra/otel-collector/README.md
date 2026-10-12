# OpenTelemetry Collector (fly.io)

The telemetry pipe. One bearer-authed OTLP/HTTP receiver → redact + batch →
**OpenObserve** (all signals) + **Grafana Mimir via door43** (metrics fan-out, converted
delta → cumulative on the way).
Kept as a collector (not worker→sink direct) so sinks are added/changed as a
collector-only change. See [`../README.md`](../README.md) for the big picture.

## Two apps, one config

| App                              | fly config      | Mimir user (= org)   | GitHub environment |
| -------------------------------- | --------------- | -------------------- | ------------------ |
| `bt-servant-otel-collector`      | `fly.toml`      | `bt-servant-staging` | `staging`          |
| `bt-servant-otel-collector-prod` | `fly.prod.toml` | `bt-servant`         | `production`       |

Both deploy the **same** `otel-collector-config.yaml` from the same pinned image, and each
runs **exactly one machine** — not for cost, but because the Mimir pipeline's
delta→cumulative state lives in one collector process (see "One converter per stream" under
[Mimir sink notes](#mimir-sink-notes)); the deploy workflow pins and asserts that count after
every deploy. The two fly configs differ only in `app` and `[env] MIMIR_USER`, and that
pairing is asserted by
[`assert-collector-invariants.py`](../../.github/scripts/assert-collector-invariants.py):
adding a third collector app means adding it to that script's `APP_MIMIR_USERS` map, in a
PR. door43 fixes the username→org mapping on their side; a new org means asking them.

A swapped user is worth a gate because it does not fail — Mimir accepts any valid
username↔password pair, so the mistake shows up as staging traffic quietly polluting the
production org's series.

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
# MIMIR_PASSWORD is the door43-issued password for the Mimir user this app declares in
# fly.toml [env] — the pair is what Mimir authenticates, and the user picks the org.
fly secrets set \
  OTEL_INGEST_TOKEN="$OTEL_INGEST_TOKEN" \
  O2_ENDPOINT="https://bt-servant-openobserve.fly.dev/api/default" \
  O2_AUTH="Basic $(printf '%s' 'you@example.com:INGEST_TOKEN' | base64)" \
  MIMIR_PASSWORD="<door43-issued password for this app's Mimir user>"
```

**Do not set `MIMIR_USER` as a secret.** It is an org identifier, not a credential, and it
lives in each app's `fly.toml [env]` (`bt-servant-staging` for staging, `bt-servant` for
prod). A fly secret **takes precedence over `[env]`**, so setting one here overrides the
reviewed value in git while `fly secrets list` shows only a digest — restoring exactly the
invisible mapping this layout eliminated. Clear a leftover with
`flyctl secrets unset --app <app> MIMIR_USER`.

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
  -e MIMIR_USER=x -e MIMIR_PASSWORD=x \
  otel/opentelemetry-collector-contrib:0.157.0 validate --config /cfg/otel-collector-config.yaml

# 2. The privacy + parameterization invariants.
python3 ../../.github/scripts/assert-collector-invariants.py otel-collector-config.yaml

# 3. Only if both pass — and name the config explicitly, since `fly deploy` defaults to
#    fly.toml and would quietly ship STAGING's app and Mimir user while you meant prod.
fly deploy --config fly.toml      --build-arg OTELCOL_VERSION=0.157.0   # staging
fly deploy --config fly.prod.toml --build-arg OTELCOL_VERSION=0.157.0   # production
```

Then land the identical config through a PR **immediately**, so the deployed state and `main`
cannot silently disagree.

### Required secrets

The config dereferences five `${env:…}` values. Four are secrets and **every one is
mandatory on every collector app**; the fifth, `MIMIR_USER`, comes from `fly.toml [env]`.

| Value               | Where it lives   | What it is                                                  |
| ------------------- | ---------------- | ----------------------------------------------------------- |
| `OTEL_INGEST_TOKEN` | fly secret       | Shared secret the worker sends as `Authorization: Bearer …` |
| `O2_ENDPOINT`       | fly secret       | OpenObserve org base URL                                    |
| `O2_AUTH`           | fly secret       | `Basic <base64(user:token)>` for OpenObserve                |
| `MIMIR_PASSWORD`    | fly secret       | door43-issued password for this app's Mimir user            |
| `MIMIR_USER`        | `fly.toml [env]` | Mimir user → org — the one value that differs per env       |

> **Any of these fails silently if you forget it.** An unset `${env:…}` resolves to an empty
> string and `otelcol validate` still exits 0 — the collector boots healthy and, with either
> `MIMIR_*` value missing, has every metrics export answered with a 401 it only logs. Neither
> half can be caught by reading the config alone, so the two are checked separately:
> [`check-collector-secrets.sh`](../../.github/scripts/check-collector-secrets.sh) queries the
> live fly app for the four secrets before shipping, and
> [`assert-collector-invariants.py`](../../.github/scripts/assert-collector-invariants.py)
> asserts the user in git. The pre-flight also **fails the deploy if `MIMIR_USER` exists as a
> secret on the app**, because a fly secret takes precedence over `[env]` — so a leftover
> would make the reviewed value in git dead code while `secrets list` showed only a digest.
> Setting that secret is not a way to override the user; it is a way to hide it.

## CI/CD

[`.github/workflows/deploy-collector.yml`](../../.github/workflows/deploy-collector.yml) owns
this directory. Nothing here is in the Worker bundle, so the main `CI` / `Deploy` workflows
ignore it entirely.

- **On PRs** that touch this directory — `otelcol validate` against the exact image tag
  pinned in the `Dockerfile`, then
  [`assert-collector-invariants.py`](../../.github/scripts/assert-collector-invariants.py),
  which parses the YAML and both fly configs and asserts exactly: the Mimir exporter
  authenticates through the `basicauth/mimir` extension whose username is
  `${env:MIMIR_USER}`, every collector app declares the user its environment is supposed to
  write as, every pipeline that exports to Mimir runs `deltatocumulative`, there is exactly
  one `user_id` action and it is `delete` on a processor every pipeline runs, and no pipeline
  exports to `debug`. `validate` type-checks the config but has no opinion on which values
  are load-bearing, so it catches none of these. Then
  [both gates' self-tests](../../.github/scripts/tests/) run — the invariant
  checker against fixtures it must reject, and the secrets pre-flight against a stubbed
  `flyctl` (so it needs no credentials) in both directions: required-secret-missing and
  banned-secret-present, and the post-deploy machine-count gate against stubbed machine
  lists (one, two, one-plus-stopped, none). A gate that has quietly stopped asserting still
  reports green, which reads as proof.
- **On push to `main` only** — pre-flight the fly secrets, then deploy with
  `flyctl deploy --remote-only --ha=false`, then
  [`pin-collector-machines.sh`](../../.github/scripts/pin-collector-machines.sh) scales the
  app to one machine and **fails the job** unless exactly one is running (fly's `--ha`
  default would otherwise hand a fresh app two machines, and fly.toml cannot cap the count).
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

### Mimir sink notes

- Smoke-test the username↔password pair first with
  [`tools/send_metrics.sh`](../../tools/send_metrics.sh) (`./tools/send_metrics.sh <mimir-user>`
  — HTTP 200 = good; it prints a `smoke_marker` to query for). Its trace-side companion is
  [`tools/send_trace.sh`](../../tools/send_trace.sh), which proves the OpenObserve leg. The
  smoke test goes **around** the collector, so it proves auth + org + ingest and nothing
  about the delta→cumulative conversion — that is the invariant script's job. It sends
  OTLP/JSON, which Mimir's OTLP parser accepts alongside protobuf (exact-match on
  `application/json` / `application/x-protobuf`; anything else is a 415).
- **Source IPs.** door43's gateway (`mimir.door43.org` and the old `metrics.door43.org`
  resolve to the same host) does not answer TCP from arbitrary networks — a laptop on a home
  ISP times out at connect. Run the smoke test from an allowed network, or prove the leg
  through the collector's fly egress, which is what the Influx sink already relied on.
- **Temporality.** The worker emits DELTA (ephemeral isolates; see the header of
  `src/services/telemetry/metrics.ts`). Mimir expects CUMULATIVE, so the `metrics/mimir`
  pipeline runs `deltatocumulative` (`max_stale: 1h`) and the OpenObserve pipeline does not.
  Counters therefore arrive in Mimir as running totals: use `rate()` / `increase()`, never
  the raw value. A collector restart reads as a counter reset, which PromQL handles.
- **One stream per isolate, in order.** `deltatocumulative` keys its state by resource
  identity and drops any point whose start is older than the stored stream's or whose
  timestamp is not strictly later. So the worker stamps a random `service.instance.id` per
  isolate (Mimir: `instance=<uuid>`) and serializes each isolate's flushes on the
  collector's acknowledgement; the collector keeps the processor **before** `batch` so that
  acknowledgement implies the delta is already accumulated (asserted by the invariant
  script). Query across isolates with `sum by (<labels>) (rate(<metric>[5m]))`. The
  OpenObserve pipeline strips the id again (`resource/strip_instance`), so OpenObserve's
  series are unchanged.
- **One converter per stream.** `deltatocumulative` keeps its running totals in the memory
  of the collector _process_, and fly load-balances requests across an app's machines with
  no affinity. With two machines, one isolate's flushes land on two converters that each
  emit the same series with partial values and interleaved timestamps, and Mimir answers
  `Partial success` with `err-mimir-sample-out-of-order` — `target_info` first, then the
  counters (seen on prod, 2026-10-12, after fly's `--ha` default had quietly given both apps
  a second machine). So each collector app runs **exactly one machine**: the deploy passes
  `--ha=false` and `pin-collector-machines.sh` asserts the count afterwards. If that
  rejection ever shows up in `fly logs` again, check `fly machines list` before anything
  else.
- **Single-flush isolates count.** A one-sample cumulative series is invisible to
  `rate()`/`increase()`, so an isolate that flushed exactly once would have contributed
  nothing. The worker therefore ships a zero-valued point at the series' start, in the same
  export and ≥1ms before the first real point (`src/services/telemetry/metrics.ts`,
  "zero-at-start"). Downstream that is `0@start, v@end` — two samples, so every isolate's
  first flush is already queryable. This is the source-side form of Mimir's experimental
  `-distributor.otel-created-timestamp-zero-ingestion-enabled`, which stays off; nothing
  here depends on a door43-side flag. Rollout check: after deploy, pick a brand-new
  `instance` in Grafana and confirm `increase(requests_total{instance="<id>"}[10m])` is
  non-zero on its first scrape window.
- **Mimir rejects delta outright** unless its experimental
  `-distributor.otel-native-delta-ingestion` is on ("If disabled, delta metrics will be
  rejected"), which is why `deltatocumulative` on the Mimir pipeline is a gated invariant
  and not a preference.
- **Cardinality.** Per-isolate identity means a new series set per isolate (bounded label
  sets × isolates). Series go stale when the isolate dies; this is the normal Prometheus
  model for ephemeral workers, but it is new load on a shared Mimir — door43 should know.
- **Orgs.** door43 maps each username to a fixed Mimir org; ours are `bt-servant-staging`
  and `bt-servant`. There is no `X-Scope-OrgID` to set — the Basic-auth user does that.
  A new org means asking door43, not a config change here.
- Verify in Grafana (the org's data source): series arrive named after each OTel metric
  with Mimir's Prometheus conventions (`requests_total`, `claude_fetch_duration_ms_bucket`,
  …), `job="<service.namespace>/<service.name>"`, and our bounded labels.

`OTEL_INGEST_TOKEN` is the value the worker must send. Store the **same** string as the
worker's `OTEL_COLLECTOR_TOKEN` secret (`wrangler secret put OTEL_COLLECTOR_TOKEN`).

## Prove it

```bash
# 1. Receiver up + bearer auth enforcing: must be 401.
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://bt-servant-otel-collector.fly.dev/v1/traces \
  -H 'Content-Type: application/json' -d '{"resourceSpans":[]}'

# 2. Startup line on the machine (there is exactly one — see "One converter per stream").
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
| Metrics → Mimir          | `./tools/send_metrics.sh <mimir-user>` (HTTP 200), then find its marker |

`debug` stays **defined but wired into no pipeline** — `verbosity: detailed` is far too
expensive under real traffic, and `send_trace.sh` + a queryable sink beat reading it out of
stdout anyway. If you ever genuinely need record-level stdout, the auditable route is a
reviewed PR that relaxes the assertion and wires the exporter **in the same diff**, shipped
through the normal workflow, then a second PR reverting it — not a local edit.

To add another sink later: add its exporter block, append it to each pipeline's `exporters:`
list (or give it its own pipeline if it needs different processors, as Mimir does), and let
the workflow deploy it — the worker is never touched.

## Notes

- fly terminates TLS on :443 and proxies to the collector's `internal_port = 4318`.
- `auto_stop_machines = "off"` + `min_machines_running = 1`: a telemetry pipe should never
  cold-start away and drop the worker's export. And never **more** than one machine: the
  Mimir pipeline needs a single delta→cumulative converter per stream (see
  [Mimir sink notes](#mimir-sink-notes)), which the workflow enforces after every deploy.
  The price is a ten-to-twenty-second restart gap per collector deploy while the one machine
  rolls; the worker's export times out at 10s and logs `otlp_metrics_flush_failed` for the
  flushes that hit it, so the gap is visible rather than silent. Blue-green would need health
  checks the collector does not define.
- Redaction here is **defense-in-depth**; the worker still redacts at source.
