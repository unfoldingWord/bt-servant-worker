# OpenTelemetry Collector (fly.io)

The telemetry pipe. One bearer-authed OTLP/HTTP receiver → redact + batch → **OpenObserve**.
Kept as a collector (not worker→OpenObserve direct) so a second sink can be added later as a
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
fly secrets set \
  OTEL_INGEST_TOKEN="$OTEL_INGEST_TOKEN" \
  O2_ENDPOINT="https://bt-servant-openobserve.fly.dev/api/default" \
  O2_AUTH="Basic $(printf '%s' 'you@example.com:INGEST_TOKEN' | base64)"

fly deploy --build-arg OTELCOL_VERSION=0.157.0   # pin a stable tag; see Dockerfile
```

`OTEL_INGEST_TOKEN` is the value the worker must send. Store the **same** string as the
worker's `OTEL_COLLECTOR_TOKEN` secret (`wrangler secret put OTEL_COLLECTOR_TOKEN`).

## Prove it

```bash
# Should 401 without the token, 200 with it.
curl -i https://bt-servant-otel-collector.fly.dev/v1/traces \
  -H "Authorization: Bearer $OTEL_INGEST_TOKEN" \
  -H 'Content-Type: application/json' -d '{"resourceSpans":[]}'

fly logs   # watch the `debug` exporter print received records
```

Then confirm the record lands in the OpenObserve UI.

## Staged bring-up

Prove one hop at a time by trimming each pipeline's `exporters:` list in
`otel-collector-config.yaml` and redeploying (worker never changes):

1. `[debug]` only — proves worker → collector + bearer auth.
2. add `otlp_http/openobserve_*` — proves the sink. **M0 done.**

Remove `debug` from the lists once the sink is confirmed. To add a second sink later, add
its exporter block + append it to each pipeline's `exporters:` list and redeploy — the
worker is never touched.

## Notes

- fly terminates TLS on :443 and proxies to the collector's `internal_port = 4318`.
- `auto_stop_machines = "off"` + `min_machines_running = 1`: a telemetry pipe should never
  cold-start away and drop the worker's export.
- Redaction here is **defense-in-depth**; the worker still redacts at source.
