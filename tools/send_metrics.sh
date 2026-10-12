#!/usr/bin/env bash
#
# Mimir ingestion smoke test — verify a door43 Mimir username↔password pair is accepted
# and lands in the org that username maps to, BEFORE (or independently of) the OTel
# collector's otlp_http/mimir_metrics exporter. Sends ONE real OTLP/JSON metric straight
# to Mimir's native OTLP endpoint, carrying a unique marker so you can find exactly it.
# Companion to send_trace.sh, which proves the collector→OpenObserve leg.
#
# Encoding: OTLP/JSON with `Content-Type: application/json`, which Mimir's OTLP parser
# accepts alongside `application/x-protobuf` (pkg/distributor/otel.go, newOTLPParser:
# exact-match switch on the two content types, 415 for anything else). JSON is used so
# this stays a dependency-free bash script; the collector itself sends protobuf.
#
# Why it sends a CUMULATIVE sum: Mimir is Prometheus-shaped and expects cumulative
# temporality. The worker emits DELTA and the collector's `deltatocumulative` processor
# converts in between — this script goes around the collector, so it has to speak Mimir's
# dialect itself. A 200 here proves auth + org + ingest; it says nothing about the
# collector's conversion, which `assert-collector-invariants.py` guards instead.
#
# Usage (preferred — the script prompts for the password, so it never touches shell
# history OR any process's argv/environment listing):
#   ./tools/send_metrics.sh <mimir-user>
# Examples:
#   ./tools/send_metrics.sh bt-servant-staging
#   ./tools/send_metrics.sh bt-servant
#
# Non-interactive (CI) alternative: export MIMIR_PASSWORD in the environment beforehand
# (e.g. from a secret store). Avoid the inline `MIMIR_PASSWORD=... ./tools/...` form —
# depending on shell/history settings the assignment can persist in history.
#
# Env overrides:
#   MIMIR_URL      full OTLP metrics URL (default https://mimir.door43.org/otlp/v1/metrics)
#   SMOKE_MARKER   the unique id to search for (default: generated)
set -euo pipefail

MIMIR_USER="${1:?usage: $0 <mimir-user>   (prompts for the password)}"
URL="${MIMIR_URL:-https://mimir.door43.org/otlp/v1/metrics}"
# Unique per run so you can find THIS sample and not a previous operator's.
MARKER="${SMOKE_MARKER:-smoke-$(date -u +%Y%m%dT%H%M%SZ)-$$}"

# Acquire the password without echoing it and without it ever appearing in argv.
if [ -z "${MIMIR_PASSWORD:-}" ]; then
  read -rs -p "Mimir password for user '${MIMIR_USER}': " MIMIR_PASSWORD
  echo
fi
[ -n "$MIMIR_PASSWORD" ] || {
  echo "❌ no password provided"
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
printf 'header = "Authorization: Basic %s"\n' \
  "$(printf '%s:%s' "$MIMIR_USER" "$MIMIR_PASSWORD" | base64 | tr -d '\n')" >"$HEADERS"

NOW_NS="$(date +%s%N)"

# One cumulative, monotonic sum with a single data point. aggregationTemporality 2 =
# CUMULATIVE in OTLP's enum (1 = DELTA). Resource attributes mirror the worker's shape
# (service.name + service.namespace) so the series lands as job="smoke/bt-servant-smoke"
# in Mimir, well away from real traffic.
cat >"$PAYLOAD" <<JSON
{
  "resourceMetrics": [{
    "resource": {
      "attributes": [
        { "key": "service.name",      "value": { "stringValue": "bt-servant-smoke" } },
        { "key": "service.namespace", "value": { "stringValue": "smoke" } }
      ]
    },
    "scopeMetrics": [{
      "scope": { "name": "tools/send_metrics.sh" },
      "metrics": [{
        "name": "btservant_smoke_test",
        "description": "Mimir ingestion smoke test; safe to delete",
        "unit": "1",
        "sum": {
          "aggregationTemporality": 2,
          "isMonotonic": true,
          "dataPoints": [{
            "startTimeUnixNano": "${NOW_NS}",
            "timeUnixNano": "${NOW_NS}",
            "asInt": "1",
            "attributes": [
              { "key": "source",       "value": { "stringValue": "smoke" } },
              { "key": "smoke_marker", "value": { "stringValue": "${MARKER}" } },
              { "key": "mimir_user",   "value": { "stringValue": "${MIMIR_USER}" } }
            ]
          }]
        }
      }]
    }]
  }]
}
JSON

echo "POST ${URL}  as ${MIMIR_USER}  (marker ${MARKER})"
HTTP_CODE=$(curl -s -o "$RESP" -w '%{http_code}' -X POST "$URL" \
  --config "$HEADERS" \
  -H 'Content-Type: application/json' \
  --data-binary @"$PAYLOAD")

echo "HTTP ${HTTP_CODE}"
BODY="$(cat "$RESP")"
[ -n "$BODY" ] && echo "Response: ${BODY}"

if [[ "$HTTP_CODE" =~ ^2 ]]; then
  echo "✅ OK — Mimir accepted the sample for user '${MIMIR_USER}'."
  echo "   Find it in Grafana (that user's org):"
  echo "     btservant_smoke_test_total{smoke_marker=\"${MARKER}\"}"
  echo "   (Mimir appends _total to monotonic sums; drop the suffix if your Mimir does not.)"
else
  echo "❌ FAILED — Mimir returned HTTP ${HTTP_CODE} for user '${MIMIR_USER}'."
  echo "   401/403 = bad username/password. 415 = content type or encoding rejected: Mimir"
  echo "   accepts exactly 'application/json' or 'application/x-protobuf' (no charset"
  echo "   suffix) and only gzip/lz4/zstd encodings — check for a proxy rewriting headers."
  exit 1
fi
