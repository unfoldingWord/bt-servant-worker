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

# expect <expected-exit-code> <label> [--must-contain <text>] -- <args to the script...>
#
# --must-contain pins WHY a fixture is rejected. Exit code alone is not enough: every
# negative fixture below is wrong in exactly one way, and if the script started rejecting
# it for some other reason (a stale fixture, say), the case would stay green while the
# assertion it exists to prove had silently stopped running.
expect() {
  local expected="$1" label="$2" must_contain=""
  shift 2
  if [ "$1" = "--must-contain" ]; then
    must_contain="$2"
    shift 2
  fi
  shift # the literal --

  local output status
  set +e
  output="$("$script" "$@" 2>&1)"
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

# ── The real repo config must pass, or the gate is broken for everyone. ────────────────
expect 0 "real repo config + real fly.tomls" -- \
  "$real_config" \
  --fly-toml "$root/infra/otel-collector/fly.toml" \
  --fly-toml "$root/infra/otel-collector/fly.prod.toml"

expect 0 "well-formed fixtures accepted" -- \
  "$real_config" \
  --fly-toml "$fixtures/good-staging.fly.toml" \
  --fly-toml "$fixtures/good-prod.fly.toml"

# ── Each of these is a way the user↔environment mapping can go wrong in git. ───────────
expect 1 "staging app authenticating as the PROD Mimir user" \
  --must-contain "must authenticate to Mimir as 'bt-servant-staging', got 'bt-servant'" -- \
  "$real_config" \
  --fly-toml "$fixtures/swapped-user.fly.toml" \
  --fly-toml "$fixtures/good-prod.fly.toml"

expect 1 "fly.toml with no [env] MIMIR_USER" --must-contain "[env] MIMIR_USER is missing" -- \
  "$real_config" \
  --fly-toml "$fixtures/missing-user.fly.toml" \
  --fly-toml "$fixtures/good-prod.fly.toml"

expect 1 "app absent from the reviewed Mimir-user map" \
  --must-contain "is not in the reviewed Mimir-user map" -- \
  "$real_config" \
  --fly-toml "$fixtures/unknown-app.fly.toml" \
  --fly-toml "$fixtures/good-prod.fly.toml"

expect 1 "a known collector app has no fly.toml at all" \
  --must-contain "no fly.toml was checked for collector app 'bt-servant-otel-collector-prod'" -- \
  "$real_config" \
  --fly-toml "$fixtures/good-staging.fly.toml"

# ── The original privacy assertion must survive the fly.toml work. ─────────────────────
expect 1 "user_id hashed instead of deleted" \
  --must-contain "user_id action must be 'delete', got 'hash'" -- \
  "$fixtures/hashed-user-id.collector-config.yaml" \
  --fly-toml "$fixtures/good-staging.fly.toml" \
  --fly-toml "$fixtures/good-prod.fly.toml"

# ── The temporality bridge. The worker emits DELTA; Mimir expects CUMULATIVE. A Mimir ──
# pipeline without `deltatocumulative` validates, boots, and then has every sample rejected
# or mis-typed at the sink — so the gate, not the collector, has to notice.
expect 1 "Mimir pipeline without deltatocumulative" \
  --must-contain "without running processors.deltatocumulative" -- \
  "$fixtures/mimir-without-deltatocumulative.collector-config.yaml" \
  --fly-toml "$fixtures/good-staging.fly.toml" \
  --fly-toml "$fixtures/good-prod.fly.toml"

# Present but after batch: the receiver's ack (which the worker serializes flushes on) no
# longer implies the delta was accumulated, so ordering across an isolate's flushes is lost.
expect 1 "deltatocumulative after batch on the Mimir pipeline" \
  --must-contain "runs processors.deltatocumulative after batch" -- \
  "$fixtures/mimir-delta-after-batch.collector-config.yaml" \
  --fly-toml "$fixtures/good-staging.fly.toml" \
  --fly-toml "$fixtures/good-prod.fly.toml"

if [ "$failures" -gt 0 ]; then
  echo "::error::$failures assert-collector-invariants.py self-test(s) failed"
  exit 1
fi

echo "All assert-collector-invariants.py self-tests passed."
