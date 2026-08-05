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

# Overridable so tests/test-check-collector-secrets.sh can stub it. This gate can fail a
# deploy in two directions and had no test until it grew teeth in #340 PR B; hardcoding
# `flyctl` meant the only way to exercise it was against a real, authenticated fly org.
FLYCTL="${FLYCTL:-flyctl}"

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
# value in git dead code while everything still looks correct, which is worse: the bucket
# an app writes to becomes invisible again, and the two environments can drift apart with
# nothing to show for it. `fly secrets list` prints digests, never values, so there is no
# way to notice by looking.
banned=(
  INFLUX_BUCKET
)

echo "Checking secrets on fly app: $app"
present="$("$FLYCTL" secrets list --app "$app" --json | jq -r '.[] | (.Name // .name)')"

missing=()
for secret in "${required[@]}"; do
  if grep -qxF "$secret" <<<"$present"; then
    echo "  ok      $secret"
  else
    echo "  MISSING $secret"
    missing+=("$secret")
  fi
done

# A hard failure since #340 PR B. It was a warning for exactly one release, because a
# failure here would have deadlocked its own fix: the gate would have blocked the very
# deploy that put [env] INFLUX_BUCKET into the machine config, and unsetting the secret
# beforehand would have left the running collector writing every metric to bucket="".
# That window is closed — no collector app carries the secret now — so the trap is shut
# permanently rather than left as a note someone has to remember.
shadowed=()
for secret in "${banned[@]}"; do
  if grep -qxF "$secret" <<<"$present"; then
    echo "  SHADOW  $secret"
    shadowed+=("$secret")
  fi
done

# Both lists are reported before exiting. Failing on the first problem found would hide
# the second, and an operator fixing a missing secret should not then discover a shadowed
# one on the next run.
status=0

if [ ${#missing[@]} -gt 0 ]; then
  echo "::error::fly app '$app' is missing required secret(s): ${missing[*]}"
  echo "An unset \${env:...} resolves to an empty string and the collector still boots, so"
  echo "this cannot be caught after deploy. Set them first:"
  echo "  $FLYCTL secrets set --app $app ${missing[*]/%/=<value>}"
  status=1
fi

if [ ${#shadowed[@]} -gt 0 ]; then
  echo "::error::fly app '$app' has secret(s) that shadow fly.toml [env]: ${shadowed[*]}"
  echo "A fly secret takes precedence over [env], so the reviewed value in git is NOT what"
  echo "this app would use — and 'secrets list' shows only a digest, so nothing would show"
  echo "the difference. Clear it, then re-run:"
  for secret in "${shadowed[@]}"; do
    echo "  $FLYCTL secrets unset --app $app $secret"
  done
  status=1
fi

if [ "$status" -ne 0 ]; then
  exit 1
fi

echo "All ${#required[@]} required secrets present on $app, and nothing shadowing [env]."
