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
# Usage (preferred — the script prompts for the token, so it never touches shell
# history OR any process's argv/environment listing):
#   ./tools/send_metrics.sh <bucket>
# Examples:
#   ./tools/send_metrics.sh bt-servant-staging
#   ./tools/send_metrics.sh bt-servant
#
# Non-interactive (CI) alternative: export INFLUX_TOKEN in the environment beforehand
# (e.g. from a secret store). Avoid the inline `INFLUX_TOKEN=... ./tools/...` form —
# depending on shell/history settings the assignment can persist in history.
#
# Env overrides:
#   INFLUX_URL   base URL (default https://metrics.door43.org)
#   MAX_LOOPS    number of points to send (default 50)
set -euo pipefail

BUCKET="${1:?usage: $0 <bucket>   (prompts for the token)}"
BASE_URL="${INFLUX_URL:-https://metrics.door43.org}"
MAX_LOOPS="${MAX_LOOPS:-50}"

# Acquire the token without echoing it and without it ever appearing in argv.
if [ -z "${INFLUX_TOKEN:-}" ]; then
  read -rs -p "InfluxDB token for bucket '${BUCKET}': " INFLUX_TOKEN
  echo
fi
[ -n "$INFLUX_TOKEN" ] || {
  echo "❌ no token provided"
  exit 1
}

URL="${BASE_URL%/}/api/v2/write?bucket=${BUCKET}"
START_TIME=$(date +%s%N) # nanoseconds — v2 /api/v2/write defaults to ns precision

PAYLOAD="$(mktemp)"
RESP="$(mktemp)"
HEADERS="$(mktemp)"
trap 'rm -f "$PAYLOAD" "$RESP" "$HEADERS"' EXIT
chmod 600 "$HEADERS"

# The auth header goes to curl via a config FILE, not -H on the command line — a header
# passed as an argument is visible to every local user in the process list (`ps`/Task
# Manager) for the duration of the request. The file is 0600 and removed on exit.
printf 'header = "X-InfluxDB-API-Token: %s"\n' "$INFLUX_TOKEN" >"$HEADERS"

for ((count = 0; count < MAX_LOOPS; count++)); do
  RAND_VAL=$((RANDOM % 101))
  # Deduct 1ms per loop so every point has a unique, sequential timestamp.
  POINT_TIME=$((START_TIME - (count * 1000000)))
  echo "btservant_smoke_test,source=smoke,bucket=${BUCKET} value=${RAND_VAL}i ${POINT_TIME}" >>"$PAYLOAD"
done

echo "POST ${URL}  (${MAX_LOOPS} points)"
HTTP_CODE=$(curl -s -o "$RESP" -w '%{http_code}' -X POST "$URL" \
  --config "$HEADERS" \
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
