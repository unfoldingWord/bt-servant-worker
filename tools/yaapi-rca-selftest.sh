#!/usr/bin/env bash
#
# Deterministic tests for tools/yaapi-rca.sh and tools/yaapi-rca-client.mjs — issue #245.
#
# The reproduction harness points at someone else's production server, so its own
# correctness cannot be checked by running it there. This runs it against
# tools/yaapi-rca-mock.py, a local MCP mock that can be told to misbehave in specific
# ways and that timestamps every request it receives.
#
# Covers: successful responses, malformed content, notification failure, SSE lifetime,
# and cleanup timing (no DELETE inside a measured window).
#
# Usage: ./tools/yaapi-rca-selftest.sh
# Exits non-zero if any case fails. Makes no network calls beyond 127.0.0.1.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

MOCK="tools/yaapi-rca-mock.py"
RCA="tools/yaapi-rca.sh"
CLIENT="tools/yaapi-rca-client.mjs"
TMP=$(mktemp -d)
PASS=0
FAIL=0

cleanup() {
  [[ -n "${MOCK_PID:-}" ]] && kill "$MOCK_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

ok() {
  PASS=$((PASS + 1))
  printf '  \033[32mPASS\033[0m %s\n' "$1"
}
no() {
  FAIL=$((FAIL + 1))
  printf '  \033[31mFAIL\033[0m %s\n     %s\n' "$1" "${2:-}"
}

free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("",0));print(s.getsockname()[1]);s.close()'; }

start_mock() { # $1=behavior -> sets PORT, LOG, MOCK_PID
  PORT=$(free_port)
  LOG="$TMP/log.$1.$PORT"
  python3 "$MOCK" "$PORT" "$LOG" "$1" >/dev/null 2>&1 &
  MOCK_PID=$!
  for _ in $(seq 1 50); do
    curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/" && break
    sleep 0.1
  done
}

stop_mock() {
  kill "$MOCK_PID" 2>/dev/null
  wait "$MOCK_PID" 2>/dev/null
  MOCK_PID=""
}

run_rca() { # $1=behavior $2=ops -> output in $OUT, mock log in $LOG
  start_mock "$1"
  OUT="$TMP/out.$1"
  YAAPI_URL="http://127.0.0.1:$PORT/mcp" CONNECT_TIMEOUT=3 MAX_TIME=8 \
    timeout 300 bash "$RCA" "$2" >"$OUT" 2>&1
  stop_mock
}

echo "yaapi-rca self-test"
echo

# ── 1. Successful responses ────────────────────────────────────────────────────
run_rca ok 4
if grep -qE '^B .*fail  0/4' "$OUT" && grep -qE '^E .*fail  0/4' "$OUT"; then
  ok "healthy server -> synthetic arms report 0 failures"
else
  no "healthy server -> synthetic arms report 0 failures" "$(grep -E '^[BE] ' "$OUT" | head -2)"
fi
if grep -qE '^A .*fail  0/4' "$OUT"; then
  ok "healthy server -> SDK client arm reports 0 failures"
elif grep -q 'SKIPPED' "$OUT"; then
  ok "SDK arm skipped cleanly when SDK unavailable"
else
  no "healthy server -> SDK client arm reports 0 failures" "$(grep -E '^A ' "$OUT")"
fi

# ── 2. Malformed content (content: [42]) ───────────────────────────────────────
run_rca badcontent 4
if grep -q 'BADCONTENT' "$OUT"; then
  ok "content:[42] -> synthetic arms report BADCONTENT"
else
  no "content:[42] -> synthetic arms report BADCONTENT" "$(grep -E '^[BCDE] ' "$OUT" | head -3)"
fi
if grep -qE '^A .*fail  [1-9]' "$OUT" || grep -q 'SKIPPED' "$OUT"; then
  ok "content:[42] -> SDK client rejects it via CallToolResultSchema"
else
  no "content:[42] -> SDK client rejects it" "$(grep -E '^A ' "$OUT")"
fi

# ── 3. Notification failure ────────────────────────────────────────────────────
run_rca notifyfail 4
if grep -q 'INIT_NOTIFY_' "$OUT" || grep -q 'SETUP_FAILED' "$OUT"; then
  ok "failing notifications/initialized -> reported, not silently passed"
else
  no "failing notifications/initialized -> reported" "$(head -6 "$OUT")"
fi
# initialize allocates a session even when notifications/initialized then 500s. Every
# session the server issued must still be DELETEd by post-arm cleanup, or failing arms
# leak sessions and contaminate later measurements.
leaked=$(python3 - "$LOG" <<'PYEOF'
import sys

issued, deleted = [], set()
for line in open(sys.argv[1]):
    parts = line.split()
    if len(parts) >= 3 and parts[1] == 'ISSUED':
        issued.append(parts[2])
    elif len(parts) >= 3 and parts[1] == 'DELETE':
        deleted.add(parts[2])
missing = [s for s in issued if s not in deleted]
print(f'{len(missing)}/{len(issued)}')
PYEOF
)
if [[ "${leaked%%/*}" == "0" && "${leaked##*/}" != "0" ]]; then
  ok "sessions from failed initialization are deleted after the arm ($leaked leaked)"
else
  no "sessions from failed initialization are deleted after the arm" "leaked $leaked"
fi

# ── 4. SSE lifetime (SDK arm opens a stream and closes it) ─────────────────────
if command -v node >/dev/null && node -e "import('@modelcontextprotocol/sdk/client/index.js')" 2>/dev/null; then
  start_mock ok
  timeout 60 node "$CLIENT" "http://127.0.0.1:$PORT/mcp" fresh 1 >"$TMP/sdk.out" 2>/dev/null
  sleep 1
  stop_mock
  if grep -q 'GET_OPEN' "$LOG"; then
    ok "SDK client opens the post-initialize SSE GET"
    open_t=$(grep -m1 'GET_OPEN' "$LOG" | awk '{print $1}')
    call_t=$(grep -m1 'POST tools/call' "$LOG" | awk '{print $1}')
    if [[ -n "$call_t" ]] && awk "BEGIN{exit !($open_t < $call_t)}"; then
      ok "SSE GET is open before the tool call (it overlaps, not serializes)"
    else
      no "SSE GET overlaps the tool call" "open=$open_t call=$call_t"
    fi
    if grep -q 'GET_CLOSE' "$LOG"; then
      ok "SSE GET is closed when the client closes (stream does not outlive it)"
    else
      no "SSE GET closed on client close" "no GET_CLOSE in log"
    fi
  else
    no "SDK client opens the post-initialize SSE GET" "$(cat "$LOG")"
  fi
else
  echo "  SKIP SSE lifetime cases (node or SDK unavailable)"
fi

# ── 5. Cleanup timing: no DELETE inside a measured window ──────────────────────
run_rca ok 4
# Arms are separated by a 10s sleep, so cluster events by gaps and assert PER ARM:
# within an arm, every cleanup DELETE must come after that arm's last measured request.
verdict=$(python3 - "$LOG" <<'PYEOF'
import sys

events = []
for line in open(sys.argv[1]):
    parts = line.split(None, 1)
    if len(parts) == 2:
        events.append((float(parts[0]), parts[1].strip()))
events.sort()

GAP = 5.0
clusters, current = [], []
for t, e in events:
    if current and t - current[-1][0] > GAP:
        clusters.append(current)
        current = []
    current.append((t, e))
if current:
    clusters.append(current)

violations = 0
for cluster in clusters:
    measured = [t for t, e in cluster if e.startswith('POST ')]
    deletes = [t for t, e in cluster if e.startswith('DELETE')]
    if measured and deletes and min(deletes) < max(measured):
        violations += 1
print('BAD %d' % violations if violations else 'GOOD')
PYEOF
)
if [[ "$verdict" == "GOOD" ]]; then
  ok "cleanup DELETEs never land inside a measured window"
else
  no "cleanup DELETEs never land inside a measured window" "DELETE seen between tools/call requests"
fi

echo
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
((FAIL == 0))
