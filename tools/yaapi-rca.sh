#!/usr/bin/env bash
#
# yaapi.bible concurrency reproduction — isolate WHY the Open Bibles MCP server
# returns HTTP 500 instead of a JSON-RPC response. See issue #245.
#
# Why this exists: during the #245 retest, yaapi.bible failed 19 of 69 connection
# attempts while the other four MCP servers failed zero times in the same window.
# The obvious suspect was our own client, which opens a fresh MCP session for every
# operation (initialize -> one call -> DELETE; see src/services/mcp/streamable-http-client.ts).
# That hypothesis was wrong, and this script is what disproved it.
#
# The design is a 2x2 factorial over the two candidate causes, plus a fifth arm that
# strips the tool call away entirely:
#
#   A  fresh session per call, 4 concurrent   our client's real pattern
#   B  one session reused,     serial         control
#   C  one session reused,     4 concurrent   concurrency WITHOUT session creation
#   D  fresh session per call, serial         session creation WITHOUT concurrency
#   E  initialize only,        4 concurrent   the handshake alone, no tools/call
#
# A vs D isolates concurrency. B vs C isolates concurrency again, with no sessions
# created during the measured phase. A vs C isolates session creation. E shows whether
# the failure needs a tool call at all.
#
# Measured 2026-08-10 at 20 ops per arm: A 30%, B 0%, C 25%, D 0%, E 25%. That is
# 0 failures in 40 serial requests against 16 in 60 concurrent ones. The server fails
# whenever two or more requests are in flight at once, regardless of session handling
# and regardless of throughput — the fastest arm (C, 400 req/min) failed while the
# slowest (D, 37.5 req/min) was clean.
#
# For the 'reuse' arms the sessions are established SERIALLY before timing starts, so
# concurrent session creation is not silently folded into the control.
#
# Usage:
#   ./tools/yaapi-rca.sh [OPS_PER_ARM]     # default 20, so 100 requests total
#
# Needs no credentials — it talks to yaapi.bible directly, not to bt-servant.
# Please keep OPS_PER_ARM modest: this points load at someone else's production server.
#
# Env overrides:
#   YAAPI_URL   MCP endpoint (default: https://yaapi.bible/mcp)
#
# Each failure is reported as INIT_* (the handshake failed) or CALL_* (the tool call
# failed), so you can see which half of the exchange broke.

set -uo pipefail

URL="${YAAPI_URL:-https://yaapi.bible/mcp}"
N="${1:-20}"
ACCEPT="application/json, text/event-stream"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Opens a session. Echoes "SID <id>" on success or "FAIL <reason>" on failure.
init_session() {
  local hdr="$TMP/h.$RANDOM.$RANDOM" body code sid
  body=$(curl -s -D "$hdr" -w '\n@@%{http_code}' -X POST "$URL" \
    -H "Content-Type: application/json" -H "Accept: $ACCEPT" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
         "protocolVersion":"2024-11-05","capabilities":{},
         "clientInfo":{"name":"yaapi-rca","version":"1.0"}}}')
  code="${body##*@@}"
  sid=$(grep -i '^mcp-session-id:' "$hdr" 2>/dev/null | tr -d '\r' | sed 's/^[^:]*: *//')
  rm -f "$hdr"
  if [[ "$body" == *"<!DOCTYPE html"* || "$body" == *"Server error"* ]]; then
    echo "FAIL INIT_HTML500"
  elif [[ "$code" != "200" ]]; then
    echo "FAIL INIT_HTTP$code"
  elif [[ -z "$sid" ]]; then
    echo "FAIL INIT_NOSESSION"
  else
    echo "SID $sid"
  fi
}

# Calls list_versions on an existing session. Echoes OK or CALL_*.
call_tool() {
  local body code
  body=$(curl -s -w '\n@@%{http_code}' -X POST "$URL" \
    -H "Content-Type: application/json" -H "Accept: $ACCEPT" \
    ${1:+-H "mcp-session-id: $1"} \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
         "name":"list_versions","arguments":{"language":"English"}}}')
  code="${body##*@@}"
  if [[ "$body" == *"<!DOCTYPE html"* || "$body" == *"Server error"* ]]; then
    echo "CALL_HTML500"
  elif [[ "$code" != "200" ]]; then
    echo "CALL_HTTP$code"
  elif [[ "$body" == *'"isError":true'* ]]; then
    echo "CALL_RPCERR"
  else
    echo "OK"
  fi
}

close_session() {
  [[ -n "${1:-}" ]] && curl -s -o /dev/null -X DELETE "$URL" -H "mcp-session-id: $1"
}

# $1=mode(fresh|reuse|initonly) $2=ops for this worker $3=outfile $4=pre-made sid (reuse only)
worker() {
  local mode="$1" ops="$2" out="$3" sid="${4:-}" r
  if [[ "$mode" == "reuse" && -z "$sid" ]]; then
    r=$(init_session)
    if [[ "$r" == SID* ]]; then
      sid="${r#SID }"
    else
      for ((i = 0; i < ops; i++)); do echo "${r#FAIL }" >>"$out"; done
      return 0
    fi
  fi
  for ((i = 1; i <= ops; i++)); do
    case "$mode" in
      fresh)
        r=$(init_session)
        if [[ "$r" == FAIL* ]]; then
          echo "${r#FAIL }" >>"$out"
          continue
        fi
        sid="${r#SID }"
        call_tool "$sid" >>"$out"
        close_session "$sid"
        ;;
      reuse)
        call_tool "$sid" >>"$out"
        ;;
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
  [[ "$mode" == "reuse" ]] && close_session "$sid"
  return 0
}

# $1=label $2=mode $3=concurrency
run_arm() {
  local label="$1" mode="$2" conc="$3" out="$TMP/$2.$3.out" per=$((N / $3))
  : >"$out"

  # Establish 'reuse' sessions serially first, so the control arm measures only
  # concurrent CALLS, never concurrent session creation.
  local -a sids=()
  local r
  if [[ "$mode" == "reuse" ]]; then
    for ((w = 1; w <= conc; w++)); do
      r=$(init_session)
      [[ "$r" == SID* ]] || {
        sleep 2
        r=$(init_session)
      }
      sids+=("${r#SID }")
      sleep 1
    done
  fi

  local t0
  t0=$(date +%s)
  for ((w = 1; w <= conc; w++)); do worker "$mode" "$per" "$out" "${sids[$((w - 1))]:-}" & done
  wait
  local el=$(($(date +%s) - t0))
  ((el == 0)) && el=1

  local tot bad init call
  tot=$(wc -l <"$out")
  bad=$(grep -cv '^OK$' "$out" || true)
  init=$(grep -c '^INIT_' "$out" || true)
  call=$(grep -c '^CALL_' "$out" || true)
  printf '%-34s %3d ops %4ds %6.1f/min   fail %2d/%-3d (%4.1f%%)   init:%-3d call:%-3d\n' \
    "$label" "$tot" "$el" "$(awk "BEGIN{print $tot/$el*60}")" "$bad" "$tot" \
    "$(awk "BEGIN{print $bad*100/$tot}")" "$init" "$call"
  sort "$out" | uniq -c | grep -v ' OK$' | sed 's/^/                                       /' || true
}

echo "yaapi.bible concurrency RCA — $N ops per arm, url=$URL"
echo "                                   ops  time     rate       failures          where"
echo "-------------------------------------------------------------------------------------------"
run_arm "A  fresh session/call, conc 4" fresh 4
sleep 10
run_arm "B  one session reused, serial" reuse 1
sleep 10
run_arm "C  one session reused, conc 4" reuse 4
sleep 10
run_arm "D  fresh session/call, serial" fresh 1
sleep 10
run_arm "E  initialize only, conc 4" initonly 4
echo
echo "A vs D isolates concurrency;  B vs C isolates it again with no session creation;"
echo "A vs C isolates session creation;  E isolates the handshake."
