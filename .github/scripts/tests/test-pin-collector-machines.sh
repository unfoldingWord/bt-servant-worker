#!/usr/bin/env bash
# Self-test for pin-collector-machines.sh.
#
# That script is a POST-DEPLOY GATE: it fails the collector deploy job when the fly app has
# anything other than exactly one machine, because a second machine is a second
# `deltatocumulative` converter and Mimir rejects the split series as out-of-order. Like the
# other gates it can break silently in both directions — stop failing (a stray machine ships
# unnoticed) or always fail (every collector deploy blocked) — and neither is visible from
# reading it.
#
# flyctl is stubbed, so this runs anywhere with no fly credentials and no network. The stub
# records every invocation so the test can also prove the self-heal (`scale count 1`) runs,
# and runs BEFORE the count is checked.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/../pin-collector-machines.sh"

stub_dir="$(mktemp -d)"
trap 'rm -rf "$stub_dir"' EXIT

# Fake flyctl: appends its argv to $FAKE_LOG, and for `machines list` emits the same shape
# as `flyctl machines list --json` for the states in $FAKE_MACHINES (comma-separated).
cat >"$stub_dir/flyctl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_LOG"
if [ "$1" = "machines" ] && [ "$2" = "list" ]; then
  python3 -c "
import json, os, sys
states = [s for s in os.environ.get('FAKE_MACHINES','').split(',') if s]
json.dump([{'id': 'm%d' % i, 'state': s, 'region': 'iad'} for i, s in enumerate(states)], sys.stdout)
"
fi
STUB
chmod +x "$stub_dir/flyctl"

failures=0

# expect <exit> <label> <machine-states> [text that must appear in output]
expect() {
  local expected="$1" label="$2" machines="$3" must_contain="${4:-}"
  local output status
  : >"$stub_dir/log"
  set +e
  output="$(FLYCTL="$stub_dir/flyctl" FAKE_LOG="$stub_dir/log" FAKE_MACHINES="$machines" "$script" some-app 2>&1)"
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

# ── The happy path: one started machine. ──────────────────────────────────────────────
expect 0 "exactly one started machine" "started" "exactly one machine"

# ── The incident: two converters behind one hostname. ─────────────────────────────────
expect 1 "two started machines" "started,started" "scale count 1"

# ── A stopped stray is still a second converter: auto_start_machines would wake it. ───
expect 1 "one started plus one stopped" "started,stopped" "found 2"

# ── Zero machines is not "at most one" — the pipe is down. ────────────────────────────
expect 1 "no machines at all" "" "found 0"

# ── The self-heal must run, and run BEFORE the count is read. ─────────────────────────
: >"$stub_dir/log"
set +e
FLYCTL="$stub_dir/flyctl" FAKE_LOG="$stub_dir/log" FAKE_MACHINES="started" "$script" some-app >/dev/null 2>&1
set -e
if [ "$(sed -n '1p' "$stub_dir/log")" = "scale count 1 --app some-app --yes" ] &&
  [ "$(sed -n '2p' "$stub_dir/log")" = "machines list --app some-app --json" ]; then
  echo "  ok      scale count 1 runs first, then machines list"
else
  echo "  FAILED  expected 'scale count 1 --app some-app --yes' then 'machines list --app some-app --json'; flyctl saw:"
  sed 's/^/            /' "$stub_dir/log"
  failures=$((failures + 1))
fi

if [ "$failures" -gt 0 ]; then
  echo "::error::$failures pin-collector-machines.sh self-test(s) failed"
  exit 1
fi

echo "All pin-collector-machines.sh self-tests passed."
