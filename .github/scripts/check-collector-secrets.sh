#!/usr/bin/env bash
# Fail a collector deploy BEFORE it ships if the fly app is missing any secret the
# config dereferences.
#
# Why this exists: `otelcol validate` resolves an unset ${env:VAR} to an empty string
# and exits 0. A collector missing INFLUX_BUCKET therefore boots healthy and writes
# every metric to bucket="" — silent data loss with a green deploy. Only the fly-app
# side can catch that, so we check it here.
#
# `flyctl secrets list` prints names + digests only; values are never readable.
set -euo pipefail

app="${1:?usage: check-collector-secrets.sh <fly-app-name>}"

# Every ${env:...} referenced by infra/otel-collector/otel-collector-config.yaml.
required=(
  OTEL_INGEST_TOKEN
  O2_ENDPOINT
  O2_AUTH
  INFLUX_TOKEN
  INFLUX_BUCKET
)

echo "Checking secrets on fly app: $app"
present="$(flyctl secrets list --app "$app" --json | jq -r '.[] | (.Name // .name)')"

missing=()
for secret in "${required[@]}"; do
  if grep -qxF "$secret" <<<"$present"; then
    echo "  ok      $secret"
  else
    echo "  MISSING $secret"
    missing+=("$secret")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "::error::fly app '$app' is missing required secret(s): ${missing[*]}"
  echo "Set them before deploying:"
  echo "  flyctl secrets set --app $app ${missing[*]/%/=<value>}"
  exit 1
fi

echo "All ${#required[@]} required secrets present on $app."
