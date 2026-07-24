#!/usr/bin/env bash
#
# InfluxDB ingestion smoke test — verify the token↔bucket auth (JJ's Nginx) and the
# auto-create-on-first-write behavior work, BEFORE wiring the OTel collector's influxdb
# exporter ("opening the sluice"). Sends N line-protocol points straight to the write API.
#
# Adapted from JJ's send_metrics.sh: parameterized for bucket/token, prints the HTTP
# status so success/failure is unambiguous, and uses a labeled, easily-purged measurement
# (`btservant_smoke_test`, tag source=smoke) instead of a generic `test_measure`.
#
# Usage:
#   INFLUX_TOKEN=<token> ./tools/send_metrics.sh <bucket>
# Examples:
#   INFLUX_TOKEN="$STAGING_TOKEN" ./tools/send_metrics.sh bt-servant-staging
#   INFLUX_TOKEN="$PROD_TOKEN"    ./tools/send_metrics.sh bt-servant
#
# Env overrides:
#   INFLUX_URL   base URL (default https://metrics.door43.org)
#   MAX_LOOPS    number of points to send (default 50)
set -euo pipefail

BUCKET="${1:?usage: INFLUX_TOKEN=<token> $0 <bucket>}"
BASE_URL="${INFLUX_URL:-https://metrics.door43.org}"
TOKEN="${INFLUX_TOKEN:?set INFLUX_TOKEN (kept out of argv so it does not land in shell history)}"
MAX_LOOPS="${MAX_LOOPS:-50}"

URL="${BASE_URL%/}/api/v2/write?bucket=${BUCKET}"
START_TIME=$(date +%s%N) # nanoseconds — v2 /api/v2/write defaults to ns precision

PAYLOAD="$(mktemp)"
RESP="$(mktemp)"
trap 'rm -f "$PAYLOAD" "$RESP"' EXIT

for ((count = 0; count < MAX_LOOPS; count++)); do
  RAND_VAL=$((RANDOM % 101))
  # Deduct 1ms per loop so every point has a unique, sequential timestamp.
  POINT_TIME=$((START_TIME - (count * 1000000)))
  echo "btservant_smoke_test,source=smoke,bucket=${BUCKET} value=${RAND_VAL}i ${POINT_TIME}" >>"$PAYLOAD"
done

echo "POST ${URL}  (${MAX_LOOPS} points)"
HTTP_CODE=$(curl -s -o "$RESP" -w '%{http_code}' -X POST "$URL" \
  -H "X-InfluxDB-API-Token: ${TOKEN}" \
  --data-binary @"$PAYLOAD")

echo "HTTP ${HTTP_CODE}"
BODY="$(cat "$RESP")"
[ -n "$BODY" ] && echo "Response: ${BODY}"

if [[ "$HTTP_CODE" =~ ^2 ]]; then
  echo "✅ OK — bucket '${BUCKET}' accepted ${MAX_LOOPS} points."
else
  echo "❌ FAILED — bucket '${BUCKET}' returned HTTP ${HTTP_CODE}."
  exit 1
fi
