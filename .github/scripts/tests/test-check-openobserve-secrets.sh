#!/usr/bin/env bash
# Self-test for check-openobserve-secrets.sh.
#
# That script is a DEPLOY GATE in both directions: it fails a deploy when a required
# secret is missing and when a secret shadows a `fly.toml [env]` key. Both directions can
# break silently in opposite ways — a gate that stopped failing waves bad configs
# through, and a gate that always fails blocks every OpenObserve deploy until someone
# debugs CI. Neither is visible from reading the script.
#
# flyctl is stubbed, so this runs anywhere with no fly credentials and no network. The
# tomls are NOT stubbed: the cases run against the real infra/openobserve/ files, so the
# [env]-key parser — the derived shadow list — is exercised on exactly what CI will feed
# it.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/../check-openobserve-secrets.sh"
staging_toml="$here/../../../infra/openobserve/fly.toml"
prod_toml="$here/../../../infra/openobserve/fly.prod.toml"

stub_dir="$(mktemp -d)"
trap 'rm -rf "$stub_dir"' EXIT

# Fake flyctl: emits the same shape as `flyctl secrets list --json` for the names in
# $FAKE_SECRETS (comma-separated). Ignores every argument, which is fine — the script's
# only use of it is that one command.
cat >"$stub_dir/flyctl" <<'STUB'
#!/usr/bin/env bash
python3 -c "
import json, os, sys
names = [n for n in os.environ.get('FAKE_SECRETS','').split(',') if n]
json.dump([{'Name': n, 'Digest': 'deadbeef'} for n in names], sys.stdout)
"
STUB
chmod +x "$stub_dir/flyctl"

failures=0
STAGING_REQUIRED="ZO_ROOT_USER_EMAIL,ZO_ROOT_USER_PASSWORD"
PROD_REQUIRED="$STAGING_REQUIRED,ZO_S3_SERVER_URL,ZO_S3_ACCESS_KEY,ZO_S3_SECRET_KEY"

# expect <exit> <label> <app> <toml> <secret-list> [text that must appear in output]
expect() {
  local expected="$1" label="$2" app="$3" toml="$4" secrets="$5" must_contain="${6:-}"
  local output status
  set +e
  output="$(FLYCTL="$stub_dir/flyctl" FAKE_SECRETS="$secrets" "$script" "$app" "$toml" 2>&1)"
  status=$?
  set -e

  if [ "$status" -ne "$expected" ]; then
    echo "  FAILED  $label — expected exit $expected, got $status"
    echo "$output" | sed 's/^/            /'
    failures=$((failures + 1))
    return
  fi
  if [ -n "$must_contain" ] && ! grep -qF "$must_contain" <<<"$output"; then
    echo "  FAILED  $label — exit $status was right, but output never mentioned '$must_contain'"
    echo "$output" | sed 's/^/            /'
    failures=$((failures + 1))
    return
  fi
  echo "  ok      $label (exit $status)"
}

echo "Testing $script"

# ── Happy paths: each app with exactly its required secrets and nothing shadowing. ─────
expect 0 "staging: both root secrets, no shadow" \
  bt-servant-openobserve "$staging_toml" "$STAGING_REQUIRED"
expect 0 "prod: all five secrets, no shadow" \
  bt-servant-openobserve-prod "$prod_toml" "$PROD_REQUIRED"

# ── Missing required secrets — the direction the issue names: wrong or missing R2 ──────
# credentials are not a boot failure, they surface later on a write path.
expect 1 "prod: missing an R2 credential" \
  bt-servant-openobserve-prod "$prod_toml" \
  "$STAGING_REQUIRED,ZO_S3_SERVER_URL,ZO_S3_ACCESS_KEY" "ZO_S3_SECRET_KEY"
expect 1 "staging: missing the root password" \
  bt-servant-openobserve "$staging_toml" "ZO_ROOT_USER_EMAIL" "ZO_ROOT_USER_PASSWORD"
expect 1 "staging: no secrets at all" \
  bt-servant-openobserve "$staging_toml" "" "ZO_ROOT_USER_EMAIL"

# ── The staging-required set must not satisfy prod. S3 comes from the per-app map. ─────
expect 1 "prod: staging's secret set is not enough" \
  bt-servant-openobserve-prod "$prod_toml" "$STAGING_REQUIRED" "ZO_S3_SERVER_URL"

# ── Shadowing: a secret named like an [env] key silently overrides the reviewed value ──
# in git (the INFLUX_BUCKET lesson, #340). The list is parsed from the real tomls, so
# these names must actually be [env] keys there.
expect 1 "staging: leftover secret shadows [env] retention" \
  bt-servant-openobserve "$staging_toml" \
  "$STAGING_REQUIRED,ZO_COMPACT_DATA_RETENTION_DAYS" "flyctl secrets unset"
expect 1 "prod: leftover secret shadows [env] bucket name" \
  bt-servant-openobserve-prod "$prod_toml" \
  "$PROD_REQUIRED,ZO_S3_BUCKET_NAME" "ZO_S3_BUCKET_NAME"

# ── Both problems at once must report BOTH, not just whichever is checked first. ───────
expect 1 "prod: missing required AND shadowed key (reports the missing one)" \
  bt-servant-openobserve-prod "$prod_toml" \
  "$STAGING_REQUIRED,ZO_S3_SERVER_URL,ZO_S3_ACCESS_KEY,ZO_LOCAL_MODE_STORAGE" "ZO_S3_SECRET_KEY"
expect 1 "prod: missing required AND shadowed key (reports the shadow too)" \
  bt-servant-openobserve-prod "$prod_toml" \
  "$STAGING_REQUIRED,ZO_S3_SERVER_URL,ZO_S3_ACCESS_KEY,ZO_LOCAL_MODE_STORAGE" "ZO_LOCAL_MODE_STORAGE"

# ── A secret whose name merely CONTAINS a required name must not satisfy it. ───────────
# `grep -qxF` is what makes this exact; a plain grep would pass on the substring.
expect 1 "near-miss name does not count as present" \
  bt-servant-openobserve "$staging_toml" \
  "ZO_ROOT_USER_EMAIL_OLD,ZO_ROOT_USER_PASSWORD" "ZO_ROOT_USER_EMAIL"

# ── An app the reviewed map does not know is a loud failure, not a best guess. ─────────
expect 1 "unknown app name fails" \
  bt-servant-openobserve-dev "$staging_toml" "$STAGING_REQUIRED" "unknown fly app"

# ── The shadow gate must not silently disarm: zero parsed [env] keys is a failure. ─────
no_env_toml="$stub_dir/no-env.toml"
printf 'app = "bt-servant-openobserve"\n[http_service]\n  internal_port = 5080\n' >"$no_env_toml"
expect 1 "toml without [env] fails rather than skipping the shadow gate" \
  bt-servant-openobserve "$no_env_toml" "$STAGING_REQUIRED" "parsed no [env] keys"

# ── A missing toml path is an error, not an empty ban list. ────────────────────────────
expect 1 "missing toml path fails" \
  bt-servant-openobserve "$stub_dir/does-not-exist.toml" "$STAGING_REQUIRED" "not found"

if [ "$failures" -gt 0 ]; then
  echo "::error::$failures check-openobserve-secrets.sh self-test(s) failed"
  exit 1
fi

echo "All check-openobserve-secrets.sh self-tests passed."
