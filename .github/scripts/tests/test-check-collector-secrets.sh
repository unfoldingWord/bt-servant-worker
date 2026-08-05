#!/usr/bin/env bash
# Self-test for check-collector-secrets.sh.
#
# That script is a DEPLOY GATE in both directions: it fails a deploy when a required secret
# is missing, and (since #340 PR B) when a banned one is present. Both directions can break
# silently in opposite ways — a gate that stopped failing waves bad configs through, and a
# gate that always fails blocks every collector deploy until someone debugs CI. Neither is
# visible from reading the script.
#
# flyctl is stubbed, so this runs anywhere with no fly credentials and no network:
# check-collector-secrets.sh calls "${FLYCTL:-flyctl}", and we point that at a fake that
# prints whatever secret list the case needs.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/../check-collector-secrets.sh"

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
ALL_REQUIRED="OTEL_INGEST_TOKEN,O2_ENDPOINT,O2_AUTH,INFLUX_TOKEN"

# expect <exit> <label> <secret-list> [text that must appear in output]
expect() {
  local expected="$1" label="$2" secrets="$3" must_contain="${4:-}"
  local output status
  set +e
  output="$(FLYCTL="$stub_dir/flyctl" FAKE_SECRETS="$secrets" "$script" some-app 2>&1)"
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

# ── The happy path: exactly the four secrets, and no bucket shadowing [env]. ───────────
expect 0 "all required present, no shadow" "$ALL_REQUIRED"

# ── The reason PR B exists. A leftover INFLUX_BUCKET secret silently overrides the ─────
# reviewed fly.toml [env] value, so the deploy must NOT proceed.
expect 1 "INFLUX_BUCKET still set as a secret" \
  "$ALL_REQUIRED,INFLUX_BUCKET" "flyctl secrets unset"

# ── The original direction must keep working. ─────────────────────────────────────────
expect 1 "a required secret is missing" \
  "OTEL_INGEST_TOKEN,O2_ENDPOINT,INFLUX_TOKEN" "O2_AUTH"

expect 1 "no secrets at all" "" "OTEL_INGEST_TOKEN"

# ── Both problems at once must report BOTH, not just whichever is checked first. ───────
expect 1 "missing required AND shadowed bucket (reports both)" \
  "OTEL_INGEST_TOKEN,O2_ENDPOINT,INFLUX_TOKEN,INFLUX_BUCKET" "O2_AUTH"
expect 1 "missing required AND shadowed bucket (reports the shadow too)" \
  "OTEL_INGEST_TOKEN,O2_ENDPOINT,INFLUX_TOKEN,INFLUX_BUCKET" "INFLUX_BUCKET"

# ── A secret whose name merely CONTAINS a required name must not satisfy it. ───────────
# `grep -qxF` is what makes this exact; a plain grep would pass on the substring.
expect 1 "near-miss name does not count as present" \
  "OTEL_INGEST_TOKEN_OLD,O2_ENDPOINT,O2_AUTH,INFLUX_TOKEN" "OTEL_INGEST_TOKEN"

if [ "$failures" -gt 0 ]; then
  echo "::error::$failures check-collector-secrets.sh self-test(s) failed"
  exit 1
fi

echo "All check-collector-secrets.sh self-tests passed."
