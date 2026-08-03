#!/usr/bin/env bash
# Fail an OpenObserve deploy BEFORE it ships if the fly app's secrets are wrong in either
# direction: a required secret missing, or a secret shadowing a reviewed `fly.toml [env]`
# value.
#
# Why this exists: OpenObserve has no `otelcol validate` equivalent — it is configured
# entirely by env vars and secrets, and wrong values are not boot failures. Missing R2
# credentials surface later on a write path; a missing root user only shows up as a login
# that never works. Only the fly-app side can catch these, so we check it here.
#
# `flyctl secrets list` prints names + digests only; values are never readable.
set -euo pipefail

usage="usage: check-openobserve-secrets.sh <fly-app-name> <fly-toml-path>"
app="${1:?$usage}"
toml="${2:?$usage}"

if [ ! -f "$toml" ]; then
  echo "::error::fly toml not found: $toml"
  exit 1
fi

# Overridable so tests/test-check-openobserve-secrets.sh can stub it — no fly
# credentials, no network. Same pattern as check-collector-secrets.sh.
FLYCTL="${FLYCTL:-flyctl}"

# Required secrets are PER APP, reviewed here (the APP_BUCKETS pattern from
# assert-collector-invariants.py): prod needs the ZO_S3_* trio because its stream data
# lives in R2; staging stores on its volume and has no S3 credentials at all. An app this
# map does not know is a loud failure, not a best guess — deploying with an unchecked
# secret set is exactly what this gate exists to prevent.
case "$app" in
  bt-servant-openobserve)
    required=(
      ZO_ROOT_USER_EMAIL
      ZO_ROOT_USER_PASSWORD
    )
    ;;
  bt-servant-openobserve-prod)
    required=(
      ZO_ROOT_USER_EMAIL
      ZO_ROOT_USER_PASSWORD
      ZO_S3_SERVER_URL
      ZO_S3_ACCESS_KEY
      ZO_S3_SECRET_KEY
    )
    ;;
  *)
    echo "::error::unknown fly app '$app' — this gate only knows bt-servant-openobserve and bt-servant-openobserve-prod. If a new OpenObserve app is real, add its required-secrets list here so it is reviewed, not guessed."
    exit 1
    ;;
esac

# Banned secrets are DERIVED, not hand-listed: every key under `[env]` in the app's fly
# toml. A fly secret silently takes precedence over `[env]`, so a leftover
# ZO_S3_BUCKET_NAME or ZO_COMPACT_DATA_RETENTION_DAYS secret makes the reviewed value in
# git dead code while `secrets list` shows only a digest — the INFLUX_BUCKET lesson
# (#340), generalized so the list cannot drift when someone adds an [env] key.
banned=()
while IFS= read -r key; do
  banned+=("$key")
done < <(awk '
  /^\[env\]/        { in_env = 1; next }
  /^\[/             { in_env = 0 }
  in_env && /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/ {
    line = $0
    sub(/^[[:space:]]*/, "", line)
    sub(/[[:space:]]*=.*/, "", line)
    print line
  }' "$toml")

# Zero parsed keys means the parser broke or [env] moved, not that shadowing became
# impossible — both tomls have always had an [env] section. A gate that quietly stops
# asserting reads as green proof, so an empty result is itself a failure.
if [ ${#banned[@]} -eq 0 ]; then
  echo "::error file=$toml::parsed no [env] keys — either the [env] section is gone or this script's parser is broken. The shadow gate cannot run, so the deploy must not either."
  exit 1
fi

echo "Checking secrets on fly app: $app (shadow list from $toml: ${banned[*]})"
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
  echo "None of these fail the boot — R2 credentials fail later on a write path, and a"
  echo "missing root user is just a login that never works. Set them first:"
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
