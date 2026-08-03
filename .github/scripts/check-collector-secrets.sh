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

# Every ${env:...} referenced by infra/otel-collector/otel-collector-config.yaml that is
# actually SECRET. INFLUX_BUCKET is deliberately absent: it is a bucket name, not a
# credential, and since B2 it lives in each app's `fly.toml [env]` where it is reviewable.
# `assert-collector-invariants.py` is what verifies it now.
required=(
  OTEL_INGEST_TOKEN
  O2_ENDPOINT
  O2_AUTH
  INFLUX_TOKEN
)

# Secrets that must NOT exist, because a fly secret silently takes precedence over
# `fly.toml [env]`. A leftover here does not break the deploy — it makes the reviewed
# value in git dead code while everything still looks correct, which is worse.
banned=(
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

# WARNING, not a failure, and only until the staging app's leftover is cleared. Failing
# here today would deadlock the very deploy that puts [env] INFLUX_BUCKET into the machine
# config: the pre-flight would block it, and unsetting the secret first would leave the
# running collector with no bucket at all (writing every metric to bucket="") until some
# later deploy landed. Order is: this PR deploys [env] -> `flyctl secrets unset
# INFLUX_BUCKET` -> the follow-up PR turns this into a hard failure.
# TODO(#340 follow-up): promote to `exit 1` once no collector app carries INFLUX_BUCKET.
shadowed=()
for secret in "${banned[@]}"; do
  if grep -qxF "$secret" <<<"$present"; then
    echo "  SHADOW  $secret"
    shadowed+=("$secret")
  fi
done

if [ ${#shadowed[@]} -gt 0 ]; then
  echo "::warning::fly app '$app' still has secret(s) that shadow fly.toml [env]: ${shadowed[*]}"
  echo "The value in git is NOT what this app is using. Clear it with:"
  for secret in "${shadowed[@]}"; do
    echo "  flyctl secrets unset --app $app $secret"
  done
fi

if [ ${#missing[@]} -gt 0 ]; then
  echo "::error::fly app '$app' is missing required secret(s): ${missing[*]}"
  echo "Set them before deploying:"
  echo "  flyctl secrets set --app $app ${missing[*]/%/=<value>}"
  exit 1
fi

echo "All ${#required[@]} required secrets present on $app."
