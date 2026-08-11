#!/usr/bin/env bash
#
# yaapi.bible concurrency reproduction — isolate WHY the Open Bibles MCP server
# returns HTTP 500 instead of a JSON-RPC response. See issue #245.
#
# Why this exists: during the #245 retest, yaapi.bible failed 19 of 69 connection
# attempts while the other four MCP servers failed zero times in the same window.
# The obvious suspect was our own client, which opens a fresh MCP session for every
# operation (initialize -> one call -> close; see src/services/mcp/streamable-http-client.ts)
# instead of pooling one session per request. This script tests that.
#
# Eight arms over session handling and concurrency. Arms C/D/E sweep concurrency on a
# single shared session so the threshold is measured rather than assumed:
#
#   A  fresh session per call,  conc 4    our client's current pattern
#   B  ONE shared session,      serial    control
#   C  ONE shared session,      conc 2    threshold sweep
#   D  ONE shared session,      conc 3    threshold sweep
#   E  ONE shared session,      conc 4    what session pooling would look like
#   F  fresh session per call,  serial    session churn WITHOUT concurrency
#   G  initialize only,         conc 4    the handshake alone, no tools/call
#   H  one session PER WORKER,  conc 4    concurrency across distinct sessions
#
# A vs F isolates concurrency. B/C/D/E isolate concurrency alone on one shared session
# with no session creation in the measured phase — B vs E decides whether pooling on
# our side would help, and C/D locate where failures begin. E vs H separates "one
# session used in parallel" from "many sessions in parallel". G shows whether a tool
# call is needed at all or the handshake alone suffices.
#
# Measured at 12 ops/arm, three independent runs. Concurrency sweep on ONE shared
# session, no session creation in the measured phase:
#
#              conc 1    conc 2    conc 3    conc 4
#   run 1        0.0%      8.3%     25.0%     50.0%
#   run 2        0.0%      8.3%     16.7%     41.7%
#   run 3        0.0%      8.3%     25.0%     41.7%
#   ---------------------------------------------------
#   pooled      0/36      3/36      8/36     16/36
#                0.0%      8.3%     22.2%     44.4%
#
# Run 3 other arms: A fresh/conc4 58.3%, F fresh/serial 0.0%, G initonly/conc4 50.0%,
# H session-per-worker/conc4 50.0%.
#
# What this supports:
#   - Serial is clean: 0 failures in 72 serial operations (arms B and F, three runs).
#   - Failures begin at concurrency 2 — 1 in 12 in every single run — and rise
#     monotonically from there.
#   - Pooling one session does NOT help: arm E shares a single session established
#     minutes earlier and still fails 42-50%. The client-side fix we were considering
#     would not have solved this.
#   - Request rate does not order the failures across arms: in run 3 arm G ran fastest
#     at 810 req/min with 50% failures while arm F ran 144 req/min completely clean.
#
# What this does NOT establish: within the B-E sweep, concurrency and instantaneous
# request rate co-vary, because each reused-session operation is exactly one request.
# The cross-arm comparisons argue against rate being the driver, but a fully
# rate-controlled design would pace requests at a fixed inter-arrival time. Treat the
# claim as "failures begin at concurrency 2 and scale with it", not as a proof that
# rate is irrelevant. Per-arm n is 12; raise OPS_PER_ARM for tighter intervals.
#
# Sessions for arms B/C/D/E/H are established SERIALLY before timing starts, so
# concurrent session creation is never folded into an arm meant to measure something
# else. If setup fails twice, the arm reports SETUP_FAILED rather than feeding a bad
# session id into measured requests.
#
# Protocol fidelity. Arm A is billed as our client's current pattern, so the emulated
# lifecycle tracks the installed SDK (1.29) rather than a plausible-looking approximation:
#   - sends LATEST_PROTOCOL_VERSION ('2025-11-25', types.js), requires the negotiated
#     version to be in SUPPORTED_PROTOCOL_VERSIONS, and stamps the negotiated
#     'mcp-protocol-version' header on every subsequent request (setProtocolVersion).
#   - sends the required notifications/initialized, then opens the GET SSE stream the
#     SDK starts on a 202 (streamableHttp.js -> _startOrAuthSse).
#   - closes the way client.close() actually closes: it ABORTS the transport and sends
#     NO DELETE. terminateSession() is a separate method this repo never calls, so the
#     real client leaks its sessions and so does this emulation.
#   - gives every request a unique JSON-RPC id (the SDK increments _requestMessageId);
#     a response counts only if a message with THAT id returns a result that satisfies
#     the SDK's schema — InitializeResult needs capabilities and serverInfo, and
#     CallToolResult's content must be ContentBlocks, not arbitrary values.
# The DELETEs this script does send are harness cleanup, issued AFTER an arm finishes
# so they never enter the measured window; without them a run would strand a session
# on the server for every fresh-session operation.
#
# Usage:
#   ./tools/yaapi-rca.sh [OPS_PER_ARM]     # default 12, minimum 4
#
# Needs no credentials — it talks to yaapi.bible directly, not through bt-servant.
#
# LOAD. Reported rates are HTTP requests/min, not operations/min, because the modes
# differ: a fresh-session op costs 4 requests in the measured window (initialize +
# notifications/initialized + GET SSE stream + tools/call), an initialize-only op costs
# 3, and a reused-session op costs 1 plus per-session setup. Post-arm cleanup adds one
# DELETE per session created. At the default of 12 ops/arm the eight arms issue roughly
# 250 HTTP requests in total, more if setup retries. This points load at a third
# party's production server, so keep the number modest and do not loop it.
#
# Env overrides:
#   YAAPI_URL          MCP endpoint                   (default: https://yaapi.bible/mcp)
#   CONNECT_TIMEOUT    curl --connect-timeout seconds (default: 10)
#   MAX_TIME           curl --max-time seconds        (default: 30)
#
# Requires: bash 4+, curl, python3 (responses are parsed structurally, not by
# substring match, so whitespace variants, notifications, unmatched ids and top-level
# JSON-RPC errors are not silently counted as successes).
#
# Result tokens: OK, HTML500, HTTP<code>, RPCERR (JSON-RPC error), TOOLERR
# (result.isError), NORESPONSE (no message with our request id), BADRESULT
# (malformed result, or InitializeResult missing capabilities/serverInfo), BADCONTENT
# (content is not a list of valid ContentBlocks), BADENVELOPE (jsonrpc != "2.0"),
# BADPROTO (negotiated
# version not in SUPPORTED_PROTOCOL_VERSIONS), BADJSON, EMPTY, TIMEOUT, CURLERR<exit>.
# Failures are prefixed INIT_ or CALL_ to show which half of the exchange broke.

set -uo pipefail

URL="${YAAPI_URL:-https://yaapi.bible/mcp}"
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-10}"
MAX_TIME="${MAX_TIME:-30}"
N="${1:-12}"
ACCEPT="application/json, text/event-stream"
CLIENT_PROTOCOL="2025-11-25" # SDK LATEST_PROTOCOL_VERSION
MAX_CONC=4

if ! [[ "$N" =~ ^[0-9]+$ ]] || ((N < MAX_CONC)); then
  echo "error: OPS_PER_ARM must be an integer >= $MAX_CONC (got '$N')." >&2
  echo "       Below $MAX_CONC the conc-$MAX_CONC arms cannot reach their labelled" >&2
  echo "       concurrency, which would make the results misleading." >&2
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
REQ="$TMP/requests"
LEAKED="$TMP/leaked"
: >"$REQ"
: >"$LEAKED"

cat >"$CLASSIFY" <<'PY'
import json, sys

kind, code, want_id = sys.argv[1], sys.argv[2], sys.argv[3]
# SDK SUPPORTED_PROTOCOL_VERSIONS
SUPPORTED = {'2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'}
raw = sys.stdin.read()

if '<!DOCTYPE html' in raw or 'Server error' in raw:
    print('HTML500'); sys.exit()
if code not in ('200', '202'):
    print('HTTP' + (code or '000')); sys.exit()

# Streamable HTTP may frame the payload as SSE. Collect EVERY data: payload as its own
# message rather than assuming the last line is the response we asked for.
lines = [l for l in raw.splitlines() if l.startswith('data:')]
chunks = [l[5:].strip() for l in lines] if lines else ([raw] if raw.strip() else [])
msgs = []
for c in chunks:
    try:
        msgs.append(json.loads(c))
    except Exception:
        pass

if kind == 'notify':
    # Notifications are accepted with 202 and normally no body; an error object is
    # still an error.
    for m in msgs:
        if isinstance(m, dict) and 'error' in m:
            print('RPCERR'); sys.exit()
    print('OK'); sys.exit()

if not chunks:
    print('EMPTY'); sys.exit()
if not msgs:
    print('BADJSON'); sys.exit()

# A response only counts if it carries OUR request id.
match = None
for m in msgs:
    if isinstance(m, dict) and 'id' in m and str(m['id']) == str(want_id):
        match = m
        break
if match is None:
    print('NORESPONSE'); sys.exit()
if match.get('jsonrpc') != '2.0':
    print('BADENVELOPE'); sys.exit()
if 'error' in match:
    print('RPCERR'); sys.exit()

result = match.get('result')
if not isinstance(result, dict):
    print('BADRESULT'); sys.exit()

if kind == 'init':
    pv = result.get('protocolVersion')
    if pv not in SUPPORTED:
        print('BADPROTO'); sys.exit()
    # SDK InitializeResultSchema also requires capabilities and serverInfo objects.
    if not isinstance(result.get('capabilities'), dict):
        print('BADRESULT'); sys.exit()
    # serverInfo is ImplementationSchema = BaseMetadata + version.
    info = result.get('serverInfo')
    if not isinstance(info, dict) or not isinstance(info.get('name'), str) \
            or not isinstance(info.get('version'), str):
        print('BADRESULT'); sys.exit()
    print('OK:' + pv); sys.exit()

if kind == 'call':
    if result.get('isError') is True:
        print('TOOLERR'); sys.exit()
    content = result.get('content')
    if not isinstance(content, list):
        print('BADRESULT'); sys.exit()
    # SDK CallToolResultSchema: content is z.array(ContentBlockSchema), a union of
    # TextContent / ImageContent / AudioContent / ResourceLink / EmbeddedResource.
    # ResourceLink is ResourceSchema + type, and ResourceSchema spreads BaseMetadata,
    # so it requires BOTH uri and name. EmbeddedResource's resource must be
    # Text/BlobResourceContents: uri plus text or blob.
    REQUIRED = {
        'text':          [('text', str)],
        'image':         [('data', str), ('mimeType', str)],
        'audio':         [('data', str), ('mimeType', str)],
        'resource_link': [('uri', str), ('name', str)],
        'resource':      [('resource', dict)],
    }
    for block in content:
        if not isinstance(block, dict):
            print('BADCONTENT'); sys.exit()
        btype = block.get('type')
        if btype not in REQUIRED:
            print('BADCONTENT'); sys.exit()
        for field, want in REQUIRED[btype]:
            if not isinstance(block.get(field), want):
                print('BADCONTENT'); sys.exit()
        if btype == 'resource':
            res = block['resource']
            if not isinstance(res.get('uri'), str):
                print('BADCONTENT'); sys.exit()
            if not isinstance(res.get('text'), str) and not isinstance(res.get('blob'), str):
                print('BADCONTENT'); sys.exit()

print('OK')
PY

# $1=payload $2=sid(opt) $3=negotiated-protocol(opt) $4=hdrfile(opt)
# Sets DP_EXIT / DP_CODE / DP_BODY. Counts one HTTP request.
do_post() {
  local payload="$1" sid="${2:-}" proto="${3:-}" hdr="${4:-/dev/null}" out
  printf '.' >>"$REQ"
  out=$(curl -s --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MAX_TIME" \
    -D "$hdr" -w '\n@@%{http_code}' -X POST "$URL" \
    -H "Content-Type: application/json" -H "Accept: $ACCEPT" \
    ${sid:+-H "mcp-session-id: $sid"} \
    ${proto:+-H "mcp-protocol-version: $proto"} \
    -d "$payload" 2>/dev/null)
  DP_EXIT=$?
  if ((DP_EXIT != 0)); then
    DP_CODE=""
    DP_BODY=""
  else
    DP_CODE="${out##*@@}"
    DP_BODY="${out%$'\n'@@*}"
  fi
}

# $1=kind(init|call|notify) $2=expected request id
classify() {
  if ((DP_EXIT == 28)); then
    echo "TIMEOUT"
    return
  fi
  if ((DP_EXIT != 0)); then
    echo "CURLERR$DP_EXIT"
    return
  fi
  printf '%s' "$DP_BODY" | python3 "$CLASSIFY" "$1" "$DP_CODE" "$2"
}

# Unique JSON-RPC ids across all workers (the SDK increments per request).
next_id() {
  RID=$((RID + 1))
  echo $(((BASHPID % 90000) * 100000 + RID))
}
RID=0

# Full lifecycle: initialize -> validate negotiated version -> notifications/initialized.
# Echoes "SID <sid> <negotiated-protocol>" or "FAIL <token>".
init_session() {
  local hdr="$TMP/h.$BASHPID.$RANDOM" verdict sid id pv
  id=$(next_id)
  do_post "{\"jsonrpc\":\"2.0\",\"id\":$id,\"method\":\"initialize\",\"params\":{
            \"protocolVersion\":\"$CLIENT_PROTOCOL\",\"capabilities\":{},
            \"clientInfo\":{\"name\":\"yaapi-rca\",\"version\":\"3.0\"}}}" "" "" "$hdr"
  verdict=$(classify init "$id")
  sid=$(grep -i '^mcp-session-id:' "$hdr" 2>/dev/null | tr -d '\r' | sed 's/^[^:]*: *//')
  rm -f "$hdr"
  [[ "$verdict" != OK:* ]] && {
    echo "FAIL INIT_$verdict"
    return
  }
  pv="${verdict#OK:}"
  [[ -z "$sid" ]] && {
    echo "FAIL INIT_NOSESSION"
    return
  }
  do_post '{"jsonrpc":"2.0","method":"notifications/initialized"}' "$sid" "$pv"
  verdict=$(classify notify 0)
  if [[ "$verdict" != "OK" ]]; then
    # The session exists even though the notification failed. Hand it to post-arm
    # cleanup rather than issuing a DELETE here: the real client never sends one, and
    # doing so inside the measured window would alter the HTTP mix being measured.
    echo "$sid $pv" >>"$LEAKED"
    echo "FAIL INIT_NOTIFY_$verdict"
    return
  fi
  open_sse "$sid" "$pv"
  echo "SID $sid $pv $SSE_PID"
}

# $1=sid $2=negotiated protocol
call_tool() {
  local id v
  id=$(next_id)
  do_post "{\"jsonrpc\":\"2.0\",\"id\":$id,\"method\":\"tools/call\",\"params\":{
            \"name\":\"list_versions\",\"arguments\":{\"language\":\"English\"}}}" "$1" "$2"
  v=$(classify call "$id")
  [[ "$v" == "OK" ]] && echo "OK" || echo "CALL_$v"
}

# The SDK opens a GET SSE stream after notifications/initialized is accepted
# (streamableHttp.js: 202 -> _startOrAuthSse). Emulate it so the HTTP mix matches.
# NOTE the explicit >/dev/null 2>&1 on the background job. init_session runs inside
# command substitution; a background child that inherits the captured stdout keeps the
# pipe open, so $(...) would block until the stream ended and the GET would never
# actually overlap the tool call — the opposite of what this arm is meant to measure.
open_sse() {
  printf '.' >>"$REQ"
  curl -sN --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MAX_TIME" -o /dev/null \
    -X GET "$URL" -H "Accept: text/event-stream" \
    -H "mcp-session-id: $1" ${2:+-H "mcp-protocol-version: $2"} \
    >/dev/null 2>&1 &
  SSE_PID=$!
}

# What client.close() actually does in SDK 1.29: abort the transport. It does NOT
# send DELETE — terminateSession() is a separate method this repo never calls.
close_client() {
  [[ -n "${1:-}" ]] && kill "$1" 2>/dev/null
  wait "$1" 2>/dev/null
  return 0
}

# Harness cleanup only, run AFTER an arm finishes so it never enters the measured
# window. The emulated client leaks these sessions exactly as the real one does.
close_session() {
  [[ -z "${1:-}" ]] && return 0
  printf '.' >>"$REQ"
  curl -s -o /dev/null --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MAX_TIME" \
    -X DELETE "$URL" -H "mcp-session-id: $1" \
    ${2:+-H "mcp-protocol-version: $2"} 2>/dev/null
  return 0
}

# $1=mode(fresh|reuse|initonly) $2=ops $3=outfile $4=sid(opt) $5=proto(opt)
worker() {
  local mode="$1" ops="$2" out="$3" sid="${4:-}" pv="${5:-}" r
  for ((i = 1; i <= ops; i++)); do
    case "$mode" in
      fresh)
        r=$(init_session)
        if [[ "$r" == FAIL* ]]; then
          echo "${r#FAIL }" >>"$out"
          continue
        fi
        read -r _ s p sse <<<"$r"
        call_tool "$s" "$p" >>"$out"
        close_client "$sse"
        echo "$s $p" >>"$LEAKED"
        ;;
      reuse) call_tool "$sid" "$pv" >>"$out" ;;
      initonly)
        r=$(init_session)
        if [[ "$r" == FAIL* ]]; then
          echo "${r#FAIL }" >>"$out"
        else
          echo "OK" >>"$out"
          read -r _ s p sse <<<"$r"
          close_client "$sse"
          echo "$s $p" >>"$LEAKED"
        fi
        ;;
    esac
  done
  return 0
}

# Serially establish one session, with a single retry. Echoes "sid proto" or "".
setup_session() {
  local r
  r=$(init_session)
  if [[ "$r" != SID* ]]; then
    sleep 2
    r=$(init_session)
  fi
  [[ "$r" == SID* ]] && echo "${r#SID }" || echo ""
}

# Release sessions the emulated client abandoned. Runs outside the measured window.
cleanup_leaked() {
  local sid pv
  while read -r sid pv; do [[ -n "$sid" ]] && close_session "$sid" "$pv"; done <"$LEAKED"
  : >"$LEAKED"
}

# $1=label $2=mode $3=concurrency $4=sessions(shared|distinct)
run_arm() {
  local label="$1" mode="$2" conc="$3" share="${4:-shared}"
  local out="$TMP/arm.$RANDOM.out"
  : >"$out"

  # Distribute the remainder so no operation is silently dropped.
  local -a ops=()
  local w base=$((N / conc)) rem=$((N % conc)) eff=0
  for ((w = 0; w < conc; w++)); do
    ops+=($((base + (w < rem ? 1 : 0))))
    ((ops[w] > 0)) && ((eff++))
  done

  local -a sids=() protos=() sses=()
  local s p sse pair
  if [[ "$mode" == "reuse" ]]; then
    local want=1
    [[ "$share" == "distinct" ]] && want=$conc
    for ((w = 0; w < want; w++)); do
      pair=$(setup_session)
      if [[ -z "$pair" ]]; then
        for ((i = 0; i < ${#sids[@]}; i++)); do
          close_client "${sses[$i]:-}"
          close_session "${sids[$i]}" "${protos[$i]}"
        done
        printf '%-34s %s\n' "$label" "SETUP_FAILED — could not establish a session (twice)"
        return 0
      fi
      read -r s p sse <<<"$pair"
      sids+=("$s")
      protos+=("$p")
      sses+=("$sse")
      sleep 1
    done
  fi

  : >"$REQ" # count only the measured phase
  local t0
  t0=$(date +%s)
  for ((w = 0; w < conc; w++)); do
    ((ops[w] == 0)) && continue
    if [[ "$mode" == "reuse" ]]; then
      local idx=0
      [[ "$share" == "distinct" ]] && idx=$w
      worker "$mode" "${ops[$w]}" "$out" "${sids[$idx]}" "${protos[$idx]}" &
    else
      worker "$mode" "${ops[$w]}" "$out" &
    fi
  done
  wait
  local el=$(($(date +%s) - t0))
  ((el == 0)) && el=1
  local reqs
  reqs=$(wc -c <"$REQ")

  for ((i = 0; i < ${#sids[@]}; i++)); do
    close_client "${sses[$i]:-}"
    close_session "${sids[$i]}" "${protos[$i]}"
  done
  cleanup_leaked

  local tot bad init call
  tot=$(wc -l <"$out")
  bad=$(grep -cv '^OK$' "$out" || true)
  init=$(grep -c '^INIT_' "$out" || true)
  call=$(grep -c '^CALL_' "$out" || true)
  if ((tot == 0)); then
    printf '%-34s %s\n' "$label" "no operations recorded"
    return 0
  fi
  printf '%-34s c=%d %3d ops %4d req %4ds %6.1f req/min  fail %2d/%-3d (%5.1f%%)  init:%-3d call:%-3d\n' \
    "$label" "$eff" "$tot" "$reqs" "$el" "$(awk "BEGIN{print $reqs/$el*60}")" \
    "$bad" "$tot" "$(awk "BEGIN{print $bad*100/$tot}")" "$init" "$call"
  sort "$out" | uniq -c | grep -v ' OK$' | sed 's/^/                                       /' || true
}

echo "yaapi.bible concurrency RCA — $N ops/arm, url=$URL, client protocol $CLIENT_PROTOCOL"
echo "                                   eff  ops  requests  time      rate       failures        where"
echo "-------------------------------------------------------------------------------------------------------"
run_arm "A  fresh/call,     conc 4" fresh 4
sleep 10
run_arm "B  ONE shared,     serial" reuse 1 shared
sleep 10
run_arm "C  ONE shared,     conc 2" reuse 2 shared
sleep 10
run_arm "D  ONE shared,     conc 3" reuse 3 shared
sleep 10
run_arm "E  ONE shared,     conc 4" reuse 4 shared
sleep 10
run_arm "F  fresh/call,     serial" fresh 1
sleep 10
run_arm "G  initialize only, conc 4" initonly 4
sleep 10
run_arm "H  session/worker,  conc 4" reuse 4 distinct
echo
echo "A vs F isolates concurrency.  B/C/D/E sweep concurrency on ONE shared session:"
echo "B vs E decides whether pooling would help; C and D locate where failures begin."
echo "E vs H separates one-session-in-parallel from many.  G tests the handshake alone."
echo
echo "Note: 'eff' is the effective concurrency actually reached. Rates are HTTP"
echo "requests/min, not ops/min — modes differ in requests per operation."
