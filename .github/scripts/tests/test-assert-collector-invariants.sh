#!/usr/bin/env bash
# Self-test for assert-collector-invariants.py.
#
# The script is a deploy gate: every collector deploy job `needs: [validate]`, and validate
# runs it. A gate that silently stops asserting is worse than no gate at all — it reads as
# proof. So each fixture here is a config that MUST be rejected, and the test fails if the
# script accepts it. Run it the same way CI does:
#
#   .github/scripts/tests/test-assert-collector-invariants.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
script="$root/.github/scripts/assert-collector-invariants.py"
fixtures="$here/fixtures"
real_config="$root/infra/otel-collector/otel-collector-config.yaml"

failures=0

# expect <expected-exit-code> <label> -- <args to the script...>
expect() {
  local expected="$1" label="$2"
  shift 3 # drop expected, label, and the literal --

  local output status
  set +e
  output="$("$script" "$@" 2>&1)"
  status=$?
  set -e

  if [ "$status" -eq "$expected" ]; then
    echo "  ok      $label (exit $status)"
  else
    echo "  FAILED  $label — expected exit $expected, got $status"
    echo "$output" | sed 's/^/            /'
    failures=$((failures + 1))
  fi
}

echo "Testing $script"

# ── The real repo config must pass, or the gate is broken for everyone. ────────────────
expect 0 "real repo config + real fly.tomls" -- \
  "$real_config" \
  --fly-toml "$root/infra/otel-collector/fly.toml" \
  --fly-toml "$root/infra/otel-collector/fly.prod.toml"

expect 0 "well-formed fixtures accepted" -- \
  "$real_config" \
  --fly-toml "$fixtures/good-staging.fly.toml" \
  --fly-toml "$fixtures/good-prod.fly.toml"

# ── Each of these is a way the bucket↔environment mapping can go wrong in git. ─────────
expect 1 "staging app pointed at the PROD bucket" -- \
  "$real_config" \
  --fly-toml "$fixtures/swapped-bucket.fly.toml" \
  --fly-toml "$fixtures/good-prod.fly.toml"

expect 1 "fly.toml with no [env] INFLUX_BUCKET" -- \
  "$real_config" \
  --fly-toml "$fixtures/missing-bucket.fly.toml" \
  --fly-toml "$fixtures/good-prod.fly.toml"

expect 1 "app absent from the reviewed bucket map" -- \
  "$real_config" \
  --fly-toml "$fixtures/unknown-app.fly.toml" \
  --fly-toml "$fixtures/good-prod.fly.toml"

expect 1 "a known collector app has no fly.toml at all" -- \
  "$real_config" \
  --fly-toml "$fixtures/good-staging.fly.toml"

# ── The original privacy assertion must survive the fly.toml work. ─────────────────────
expect 1 "user_id hashed instead of deleted" -- \
  "$fixtures/hashed-user-id.collector-config.yaml" \
  --fly-toml "$fixtures/good-staging.fly.toml" \
  --fly-toml "$fixtures/good-prod.fly.toml"

if [ "$failures" -gt 0 ]; then
  echo "::error::$failures assert-collector-invariants.py self-test(s) failed"
  exit 1
fi

echo "All assert-collector-invariants.py self-tests passed."
