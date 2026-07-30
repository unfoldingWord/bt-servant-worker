#!/usr/bin/env bash
#
# Collector→sink smoke test — send ONE real, non-empty OTLP span through a collector and
# out to OpenObserve, BEFORE enabling the worker's telemetry secrets ("the switch").
# Companion to send_metrics.sh, which tests the InfluxDB leg.
#
# Why this exists: an empty batch (`{"resourceSpans":[]}`) returns HTTP 200 and proves the
# receiver and bearer auth work, but it creates NO span — so there is nothing to look for
# in the sink, and the collector→OpenObserve hop stays unproven until real user traffic
# arrives. That is far too late to be discovering a broken exporter. This sends a span
# carrying a unique marker so you can query for exactly it.
#
# Usage (preferred — prompts for the token, so it never touches shell history OR any
# process's argv/environment listing):
#   ./tools/send_trace.sh <collector-host>
# Examples:
#   ./tools/send_trace.sh bt-servant-otel-collector.fly.dev
#   ./tools/send_trace.sh bt-servant-otel-collector-prod.fly.dev
#
# Non-interactive (CI) alternative: export OTEL_INGEST_TOKEN beforehand. Avoid the inline
# `OTEL_INGEST_TOKEN=... ./tools/...` form — depending on shell/history settings the
# assignment can persist in history.
#
# Env overrides:
#   SMOKE_MARKER   the unique id to search for (default: generated)
#   SERVICE_NAME   resource service.name (default bt-servant-smoke)
#   NAMESPACE      resource service.namespace (default smoke)
set -euo pipefail

HOST="${1:?usage: $0 <collector-host>   (prompts for the token)}"
HOST="${HOST#https://}"
HOST="${HOST%/}"
URL="https://${HOST}/v1/traces"

SERVICE_NAME="${SERVICE_NAME:-bt-servant-smoke}"
NAMESPACE="${NAMESPACE:-smoke}"
# Unique per run so you can find THIS span and not a previous operator's.
MARKER="${SMOKE_MARKER:-smoke-$(date -u +%Y%m%dT%H%M%SZ)-$$}"

if [ -z "${OTEL_INGEST_TOKEN:-}" ]; then
  read -rs -p "Collector ingest token for '${HOST}': " OTEL_INGEST_TOKEN
  echo
fi
[ -n "$OTEL_INGEST_TOKEN" ] || {
  echo "❌ no token provided"
  exit 1
}

PAYLOAD="$(mktemp)"
RESP="$(mktemp)"
HEADERS="$(mktemp)"
trap 'rm -f "$PAYLOAD" "$RESP" "$HEADERS"' EXIT
chmod 600 "$HEADERS"

# The auth header goes to curl via a config FILE, not -H on the command line — a header
# passed as an argument is visible to every local user in the process list (`ps`/Task
# Manager) for the duration of the request. The file is 0600 and removed on exit.
{
  printf 'header = "Authorization: Bearer %s"\n' "$OTEL_INGEST_TOKEN"
  printf 'header = "Content-Type: application/json"\n'
} >"$HEADERS"

# OTLP/HTTP JSON requires traceId = 16 bytes hex (32 chars), spanId = 8 bytes (16 chars),
# and timestamps as STRINGS of nanoseconds (they exceed JSON's safe integer range).
TRACE_ID="$(openssl rand -hex 16)"
SPAN_ID="$(openssl rand -hex 8)"
END_NS="$(date +%s)000000000"
START_NS="$((${END_NS%000000000} - 1))000000000"

cat >"$PAYLOAD" <<JSON
{
  "resourceSpans": [
    {
      "resource": {
        "attributes": [
          { "key": "service.name", "value": { "stringValue": "${SERVICE_NAME}" } },
          { "key": "service.namespace", "value": { "stringValue": "${NAMESPACE}" } }
        ]
      },
      "scopeSpans": [
        {
          "scope": { "name": "bringup-smoke" },
          "spans": [
            {
              "traceId": "${TRACE_ID}",
              "spanId": "${SPAN_ID}",
              "name": "collector-sink-smoke",
              "kind": 1,
              "startTimeUnixNano": "${START_NS}",
              "endTimeUnixNano": "${END_NS}",
              "attributes": [
                { "key": "smoke_marker", "value": { "stringValue": "${MARKER}" } }
              ],
              "status": {}
            }
          ]
        }
      ]
    }
  ]
}
JSON

echo "POST ${URL}"
echo "  marker:   ${MARKER}"
echo "  trace id: ${TRACE_ID}"
HTTP_CODE=$(curl -s -o "$RESP" -w '%{http_code}' -X POST "$URL" \
  --config "$HEADERS" \
  --data-binary @"$PAYLOAD")

echo "HTTP ${HTTP_CODE}"
BODY="$(cat "$RESP")"
[ -n "$BODY" ] && echo "Response: ${BODY}"

if [[ "$HTTP_CODE" =~ ^2 ]]; then
  cat <<EOF
✅ Collector accepted the span.

   NOT done yet — a 2xx only proves the receiver took it. Now confirm it reached the sink:
   query the OpenObserve traces stream for

       smoke_marker = '${MARKER}'      (or trace id ${TRACE_ID})

   If the collector accepted it but nothing appears in OpenObserve, the exporter leg is
   broken — check \`fly logs\` for export errors. That is exactly the failure this script
   exists to surface before real traffic depends on it.
EOF
else
  echo "❌ FAILED — ${HOST} returned HTTP ${HTTP_CODE}."
  echo "   401 ⇒ wrong/missing ingest token. 404 ⇒ wrong host or path."
  exit 1
fi
