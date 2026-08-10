#!/usr/bin/env bash
#
# yaapi.bible concurrency reproduction — isolate WHY the Open Bibles MCP server
# returns HTTP 500 instead of a JSON-RPC response. See issue #245.
#
# Why this exists: during the #245 retest, yaapi.bible failed 19 of 69 connection
# attempts while the other four MCP servers failed zero times in the same window.
# The obvious suspect was our own client, which opens a fresh MCP session for every
# operation (initialize -> one call -> DELETE; see src/services/mcp/streamable-http-client.ts)
# instead of pooling one session per request. This script tests that.
#
# Six arms over the two candidate causes — session handling and concurrency:
#
#   A  fresh session per call,   4 concurrent   our client's current pattern
#   B  ONE shared session,       serial         control
#   C  ONE shared session,       4 concurrent   what session pooling would look like
#   D  fresh session per call,   serial         session churn WITHOUT concurrency
#   E  initialize only,          4 concurrent   the handshake alone, no tools/call
#   F  one session PER WORKER,   4 concurrent   concurrency across distinct sessions
#
# A vs D isolates concurrency. B vs C isolates concurrency with a single shared
# session and no session creation during the measured phase — this is the arm that
# decides whether pooling on our side would help. C vs F separates "many sessions in
# parallel" from "one session used in parallel". E shows whether a tool call is needed
# at all, or whether the handshake alone is enough to break it.
#
# Measured 2026-08-10 at 12 ops/arm:
#
#   A fresh/conc4      66.7%      B shared/serial     0.0%
#   C shared/conc4     50.0%      D fresh/serial      0.0%
#   E initonly/conc4   33.3%      F per-worker/conc4 50.0%
#
# That is 0 failures in 24 serial operations against 24 in 48 concurrent ones. Every
# concurrent arm fails at a similar rate whether it opens a session per call, shares
# one session across all four workers, gives each worker its own, or never issues a
# tool call at all. Throughput is not the variable: arm C sustained 360 req/min and
# failed, arm D ran 28.8 req/min and was clean.
#
# Conclusion: the server fails whenever two or more requests are in flight at once.
# Arm C is the one that matters for us — pooling a single session, which is the fix
# we were considering for our own client, still fails 50% under concurrency. It would
# not have solved this.
#
# Sessions for arms B, C and F are established SERIALLY before timing starts, so
# concurrent session creation is never folded into an arm meant to measure something
# else. If setup fails twice for an arm, that arm is reported as SETUP_FAILED rather
# than feeding a bad session id into the measured requests.
#
# Fidelity note: the handshake here performs the full MCP lifecycle the SDK performs —
# POST initialize, validate the returned InitializeResult, then send the required
# notifications/initialized — before any tools/call. A bare 200 with a session header
# is NOT a completed initialization, and treating it as one would attribute behavior
# to the wrong request sequence.
#
# Usage:
#   ./tools/yaapi-rca.sh [OPS_PER_ARM]     # default 12
#
# Needs no credentials — it talks to yaapi.bible directly, not through bt-servant.
#
# LOAD. "Ops" are measured operations, not HTTP requests. Each fresh-session op costs
# 4 requests (initialize + notifications/initialized + tools/call + DELETE); each
# initialize-only op costs 3; each reused-session op costs 1 plus per-session setup.
# At the default of 12 ops/arm the six arms issue roughly 186 HTTP requests in total
# (more if setup retries). This points load at a third party's production server, so
# please keep the number modest and do not loop it.
#
# Env overrides:
#   YAAPI_URL          MCP endpoint         (default: https://yaapi.bible/mcp)
#   CONNECT_TIMEOUT    curl --connect-timeout seconds (default: 10)
#   MAX_TIME           curl --max-time seconds        (default: 30)
#
# Requires: bash 4+, curl, python3 (used to parse responses structurally rather than
# by substring match, so that whitespace variants and top-level JSON-RPC errors are
# not silently counted as successes).
#
# Result tokens: OK, HTML500, HTTP<code>, RPCERR (top-level JSON-RPC error),
# TOOLERR (result.isError), BADINIT (no protocolVersion), BADJSON, EMPTY,
# TIMEOUT, CURLERR<exit>. Failures are prefixed INIT_ or CALL_ to show which half
# of the exchange broke.

set -uo pipefail

URL="${YAAPI_URL:-https://yaapi.bible/mcp}"
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-10}"
MAX_TIME="${MAX_TIME:-30}"
N="${1:-12}"
ACCEPT="application/json, text/event-stream"

if ! [[ "$N" =~ ^[0-9]+$ ]] || ((N < 1)); then
  echo "error: OPS_PER_ARM must be a positive integer (got '$N')" >&2
  exit 2
fi
for dep in curl python3; do
  command -v "$dep" >/dev/null || {
    echo "error: $dep is required" >&2
    exit 2
  }
done

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
CLASSIFY="$TMP/classify.py"

cat >"$CLASSIFY" <<'PY'
import json, sys
kind, code = sys.argv[1], sys.argv[2]
raw = sys.stdin.read()
if '<!DOCTYPE html' in raw or 'Server error' in raw:
    print('HTML500'); sys.exit()
if code not in ('200', '202'):
    print('HTTP' + (code or '000')); sys.exit()
# Streamable HTTP may frame the payload as SSE; take the last data: line if so.
data = [l[6:] for l in raw.splitlines() if l.startswith('data: ')]
body = data[-1] if data else raw
if not body.strip():
    # An accepted notification legitimately has no body.
    print('OK' if kind == 'notify' else 'EMPTY'); sys.exit()
try:
    doc = json.loads(body)
except Exception:
    print('BADJSON'); sys.exit()
if not isinstance(doc, dict):
    print('BADJSON'); sys.exit()
if 'error' in doc:
    print('RPCERR'); sys.exit()
result = doc.get('result')
if kind == 'init':
    if not isinstance(result, dict) or not result.get('protocolVersion'):
        print('BADINIT'); sys.exit()
if kind == 'call':
    if isinstance(result, dict) and result.get('isError') is True:
        print('TOOLERR'); sys.exit()
print('OK')
PY

# POST a payload. Sets DP_EXIT / DP_CODE / DP_BODY. $1=payload $2=sid(opt) $3=hdrfile(opt)
do_post() {
  local payload="$1" sid="${2:-}" hdr="${3:-/dev/null}" out
  out=$(curl -s --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MAX_TIME" \
    -D "$hdr" -w '\n@@%{http_code}' -X POST "$URL" \
    -H "Content-Type: application/json" -H "Accept: $ACCEPT" \
    ${sid:+-H "mcp-session-id: $sid"} -d "$payload" 2>/dev/null)
  DP_EXIT=$?
  if ((DP_EXIT != 0)); then
    DP_CODE=""
    DP_BODY=""
  else
    DP_CODE="${out##*@@}"
    DP_BODY="${out%$'\n'@@*}"
  fi
}

# $1=kind(init|call|notify) -> classification token
classify() {
  if ((DP_EXIT == 28)); then
    echo "TIMEOUT"
    return
  fi
  if ((DP_EXIT != 0)); then
    echo "CURLERR$DP_EXIT"
    return
  fi
  printf '%s' "$DP_BODY" | python3 "$CLASSIFY" "$1" "$DP_CODE"
}

# Full MCP handshake: initialize -> validate -> notifications/initialized.
# Echoes "SID <id>" or "FAIL <token>".
init_session() {
  local hdr="$TMP/h.$$.$RANDOM" verdict sid
  do_post '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":"2024-11-05","capabilities":{},
            "clientInfo":{"name":"yaapi-rca","version":"2.0"}}}' "" "$hdr"
  verdict=$(classify init)
  sid=$(grep -i '^mcp-session-id:' "$hdr" 2>/dev/null | tr -d '\r' | sed 's/^[^:]*: *//')
  rm -f "$hdr"
  [[ "$verdict" != "OK" ]] && {
    echo "FAIL INIT_$verdict"
    return
  }
  [[ -z "$sid" ]] && {
    echo "FAIL INIT_NOSESSION"
    return
  }
  do_post '{"jsonrpc":"2.0","method":"notifications/initialized"}' "$sid"
  verdict=$(classify notify)
  [[ "$verdict" != "OK" ]] && {
    echo "FAIL INIT_NOTIFY_$verdict"
    return
  }
  echo "SID $sid"
}

call_tool() {
  do_post '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
            "name":"list_versions","arguments":{"language":"English"}}}' "${1:-}"
  local v
  v=$(classify call)
  [[ "$v" == "OK" ]] && echo "OK" || echo "CALL_$v"
}

close_session() {
  [[ -n "${1:-}" ]] && curl -s -o /dev/null --connect-timeout "$CONNECT_TIMEOUT" \
    --max-time "$MAX_TIME" -X DELETE "$URL" -H "mcp-session-id: $1" 2>/dev/null
  return 0
}

# $1=mode(fresh|reuse|initonly) $2=ops $3=outfile $4=sid (reuse only)
worker() {
  local mode="$1" ops="$2" out="$3" sid="${4:-}" r
  for ((i = 1; i <= ops; i++)); do
    case "$mode" in
      fresh)
        r=$(init_session)
        if [[ "$r" == FAIL* ]]; then
          echo "${r#FAIL }" >>"$out"
          continue
        fi
        call_tool "${r#SID }" >>"$out"
        close_session "${r#SID }"
        ;;
      reuse) call_tool "$sid" >>"$out" ;;
      initonly)
        r=$(init_session)
        if [[ "$r" == FAIL* ]]; then
          echo "${r#FAIL }" >>"$out"
        else
          echo "OK" >>"$out"
          close_session "${r#SID }"
        fi
        ;;
    esac
  done
  return 0
}

# Serially establish one session, with a single retry. Echoes sid, or "" on failure.
setup_session() {
  local r
  r=$(init_session)
  if [[ "$r" != SID* ]]; then
    sleep 2
    r=$(init_session)
  fi
  [[ "$r" == SID* ]] && echo "${r#SID }" || echo ""
}

# $1=label $2=mode $3=concurrency $4=sessions(shared|distinct, reuse arms only)
run_arm() {
  local label="$1" mode="$2" conc="$3" share="${4:-shared}"
  local out="$TMP/arm.$RANDOM.out"
  : >"$out"

  # Ops are split across workers; the remainder is distributed so that no operation
  # is silently dropped when N is not a multiple of the concurrency.
  local -a ops=()
  local w base=$((N / conc)) rem=$((N % conc))
  for ((w = 0; w < conc; w++)); do ops+=($((base + (w < rem ? 1 : 0)))); done

  local -a sids=()
  local s
  if [[ "$mode" == "reuse" ]]; then
    local want=1
    [[ "$share" == "distinct" ]] && want=$conc
    for ((w = 0; w < want; w++)); do
      s=$(setup_session)
      if [[ -z "$s" ]]; then
        for x in "${sids[@]:-}"; do close_session "$x"; done
        printf '%-36s %s\n' "$label" "SETUP_FAILED — could not establish a session (twice)"
        return 0
      fi
      sids+=("$s")
      sleep 1
    done
  fi

  local t0
  t0=$(date +%s)
  for ((w = 0; w < conc; w++)); do
    ((ops[w] == 0)) && continue
    if [[ "$mode" == "reuse" ]]; then
      # shared: every worker uses sids[0]. distinct: worker w uses sids[w].
      [[ "$share" == "shared" ]] && s="${sids[0]}" || s="${sids[$w]}"
      worker "$mode" "${ops[$w]}" "$out" "$s" &
    else
      worker "$mode" "${ops[$w]}" "$out" &
    fi
  done
  wait
  local el=$(($(date +%s) - t0))
  ((el == 0)) && el=1

  for s in "${sids[@]:-}"; do close_session "$s"; done

  local tot bad init call
  tot=$(wc -l <"$out")
  bad=$(grep -cv '^OK$' "$out" || true)
  init=$(grep -c '^INIT_' "$out" || true)
  call=$(grep -c '^CALL_' "$out" || true)
  if ((tot == 0)); then
    printf '%-36s %s\n' "$label" "no operations recorded"
    return 0
  fi
  printf '%-36s %3d ops %4ds %6.1f/min  fail %2d/%-3d (%5.1f%%)  init:%-3d call:%-3d\n' \
    "$label" "$tot" "$el" "$(awk "BEGIN{print $tot/$el*60}")" "$bad" "$tot" \
    "$(awk "BEGIN{print $bad*100/$tot}")" "$init" "$call"
  sort "$out" | uniq -c | grep -v ' OK$' | sed 's/^/                                         /' || true
}

echo "yaapi.bible concurrency RCA — $N ops/arm, url=$URL"
echo "                                     ops  time     rate      failures         where"
echo "---------------------------------------------------------------------------------------------"
run_arm "A  fresh session/call, conc 4" fresh 4
sleep 10
run_arm "B  ONE shared session,   serial" reuse 1 shared
sleep 10
run_arm "C  ONE shared session,   conc 4" reuse 4 shared
sleep 10
run_arm "D  fresh session/call, serial" fresh 1
sleep 10
run_arm "E  initialize only,     conc 4" initonly 4
sleep 10
run_arm "F  session per worker,  conc 4" reuse 4 distinct
echo
echo "A vs D isolates concurrency.  B vs C tests whether pooling ONE session would help."
echo "C vs F separates one-session-in-parallel from many-sessions-in-parallel."
echo "E shows whether the handshake alone is enough to trigger it."
