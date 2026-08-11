#!/usr/bin/env bash
#
# yaapi.bible concurrency reproduction — isolate WHY the Open Bibles MCP server
# returns HTTP 500 instead of a JSON-RPC response. See issue #245.
#
# Why this exists: during the #245 retest, yaapi.bible failed 19 of 69 connection
# attempts while the other four MCP servers failed zero times in the same window.
# The obvious suspect was our own client, which opens a fresh MCP session for every
# operation (connect -> one call -> close; see src/services/mcp/streamable-http-client.ts)
# instead of pooling one session per request. This script tests that.
#
# TWO KINDS OF ARM. Read this before quoting any number from the output.
#
#   REAL-CLIENT arms (A, G) are driven by tools/yaapi-rca-client.mjs, which uses the
#   @modelcontextprotocol/sdk this repository depends on. The SDK owns initialization,
#   protocol negotiation, the post-initialize SSE stream, request ids, shutdown, and
#   response schema validation. These arms are what our client actually does.
#
#   SYNTHETIC arms (B, C, D, E, H) are plain curl POSTs. They are NOT an emulation of
#   the SDK and no claim is made that they reproduce it. They exist only to vary
#   concurrency against a session while holding everything else still, which is what
#   the core question needs. Their pass/fail checks are exactly, and only:
#     HTTP status is 200/202; the body is not a Django HTML error page; the body
#     parses as JSON; jsonrpc == "2.0"; a message carrying OUR request id came back;
#     that message has no top-level error; it has an object result; for tools/call
#     result.content is a list. That is a deliberately shallow check, sufficient to
#     tell "the server answered" from "the server 500'd", and nothing more.
#
#   Arms:
#     A  REAL CLIENT, fresh session per call,  conc 4    our client's actual pattern
#     B  synthetic, ONE shared session,        serial    control
#     C  synthetic, ONE shared session,        conc 2    threshold sweep
#     D  synthetic, ONE shared session,        conc 3    threshold sweep
#     E  synthetic, ONE shared session,        conc 4    what pooling would look like
#     F  REAL CLIENT, fresh session per call,  serial    churn WITHOUT concurrency
#     G  REAL CLIENT, handshake only,          conc 4    connect/close, no tool call
#     H  synthetic, one session PER WORKER,    conc 4    concurrency across sessions
#
# A vs F isolates concurrency for the real client. B/C/D/E sweep concurrency on one
# shared session with no session creation in the measured phase — B vs E decides
# whether pooling on our side would help, and C/D locate where failures begin.
# E vs H separates one-session-in-parallel from many. G tests the handshake alone.
#
# CLEANUP. The SDK's close() aborts the transport and sends no DELETE; terminateSession()
# is a separate method this repo never calls, so the real client leaks its sessions and
# so does arm A. Every session this script creates is queued and released only AFTER its
# arm finishes, so cleanup traffic never enters a measured window.
#
# RESULTS at 12 ops/arm.
#
# Real client, driven by the installed SDK:
#   F  serial            0.0%      A  concurrency 4    66.7%
#   G  handshake only, concurrency 4        25.0%
#
# Synthetic sweep on ONE shared session, four independent runs:
#
#              conc 1    conc 2    conc 3    conc 4
#   run 1        0.0%      8.3%     25.0%     50.0%
#   run 2        0.0%      8.3%     16.7%     41.7%
#   run 3        0.0%      8.3%     25.0%     41.7%
#   run 4        0.0%      8.3%     25.0%     50.0%
#   ---------------------------------------------------
#   pooled      0/48      4/48     11/48     22/48
#                0.0%      8.3%     22.9%     45.8%
#
# What this supports:
#   - The repo's own client, unmodified, is clean serially and fails two thirds of the
#     time at concurrency 4. No emulation is involved in that comparison.
#   - The synthetic sweep locates the onset: failures begin at concurrency 2, at
#     exactly 1 in 12 in all four runs, and rise monotonically from there.
#   - Serial is clean in every arm and every run.
#   - Pooling one session does NOT help: arm E shares a single session established
#     minutes earlier and still fails 42-50%. The client-side fix we were considering
#     would not have solved this.
#
# What this does NOT establish: within the B-E sweep, concurrency and instantaneous
# request rate co-vary, because each reused-session operation is exactly one request.
# A fully rate-controlled design would pace requests at a fixed inter-arrival time.
# Treat the claim as "failures begin at concurrency 2 and scale with it", not as proof
# that rate is irrelevant. Per-arm n is 12; raise OPS_PER_ARM for tighter intervals.
#
# Usage:
#   ./tools/yaapi-rca.sh [OPS_PER_ARM]      # default 12, minimum 4
#   ./tools/yaapi-rca-selftest.sh           # deterministic tests against a local mock
#
# Needs no credentials for the target server. The real-client arms need node and this
# repo's node_modules; if node or the SDK is missing those arms are skipped with a
# notice and the synthetic arms still run.
#
# LOAD. Synthetic arms count every HTTP request they issue and report requests/min.
# Real-client arms are driven by the SDK, which issues requests this script does not
# see, so their request count and rate show "n/a" rather than a number this script
# cannot honestly produce. At the default of 12 ops/arm expect very roughly 250 HTTP
# requests in total. This points load at a third party's production server, so keep the
# number modest and do not loop it.
#
# Env overrides:
#   YAAPI_URL          MCP endpoint                   (default: https://yaapi.bible/mcp)
#   CONNECT_TIMEOUT    curl --connect-timeout seconds (default: 10)
#   MAX_TIME           curl --max-time seconds        (default: 30)
#
# Requires: bash 4+, curl, python3. Optional: node (real-client arms).
#
# Synthetic-arm result tokens: OK, HTML500, HTTP<code>, RPCERR, TOOLERR, NORESPONSE,
# BADRESULT, BADENVELOPE, BADJSON, EMPTY, TIMEOUT, CURLERR<exit>. Real-client tokens
# come from the SDK and are prefixed INIT_ or CALL_ by the phase that raised them.

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

SDK_CLIENT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/yaapi-rca-client.mjs"
SDK_OK=0
if command -v node >/dev/null && [[ -f "$SDK_CLIENT" ]] &&
  node -e "import('@modelcontextprotocol/sdk/client/index.js')" >/dev/null 2>&1; then
  SDK_OK=1
fi

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
  echo "SID $sid $pv"
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
        read -r _ s p <<<"$r"
        call_tool "$s" "$p" >>"$out"
        echo "$s $p" >>"$LEAKED"
        ;;
      reuse) call_tool "$sid" "$pv" >>"$out" ;;
      initonly)
        r=$(init_session)
        if [[ "$r" == FAIL* ]]; then
          echo "${r#FAIL }" >>"$out"
        else
          echo "OK" >>"$out"
          read -r _ s p <<<"$r"
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

# Real-client arm: concurrency and collection here, MCP protocol entirely in the SDK.
# $1=label $2=mode(fresh|initonly) $3=concurrency
run_sdk_arm() {
  local label="$1" mode="$2" conc="$3"
  local out="$TMP/sdk.$RANDOM.out" raw="$TMP/raw.$RANDOM"
  : >"$out"
  : >"$raw"
  if ((SDK_OK == 0)); then
    printf '%-36s %s\n' "$label" "SKIPPED — needs node + @modelcontextprotocol/sdk"
    return 0
  fi

  local -a ops=()
  local w base=$((N / conc)) rem=$((N % conc)) eff=0
  for ((w = 0; w < conc; w++)); do
    ops+=($((base + (w < rem ? 1 : 0))))
    ((ops[w] > 0)) && ((eff++))
  done

  local t0
  t0=$(date +%s)
  for ((w = 0; w < conc; w++)); do
    ((ops[w] == 0)) && continue
    node "$SDK_CLIENT" "$URL" "$mode" "${ops[$w]}" >>"$raw" 2>/dev/null &
  done
  wait
  local el=$(($(date +%s) - t0))
  ((el == 0)) && el=1

  local kind a b
  while read -r kind a b; do
    case "$kind" in
      SESSION) echo "$a" >>"$LEAKED" ;;
      RESULT) [[ "$a" == "OK" ]] && echo "OK" >>"$out" || echo "$b" >>"$out" ;;
    esac
  done <"$raw"
  cleanup_leaked # SDK close() sends no DELETE; release sessions now the arm is done

  local tot bad init call
  tot=$(wc -l <"$out")
  bad=$(grep -cv '^OK$' "$out" || true)
  init=$(grep -c '^INIT_' "$out" || true)
  call=$(grep -c '^CALL_' "$out" || true)
  if ((tot == 0)); then
    printf '%-36s %s\n' "$label" "no operations recorded (node worker produced nothing)"
    return 0
  fi
  printf '%-36s c=%d %3d ops  n/a req %4ds       n/a       fail %2d/%-3d (%5.1f%%)  init:%-3d call:%-3d\n' \
    "$label" "$eff" "$tot" "$el" "$bad" "$tot" \
    "$(awk "BEGIN{print $bad*100/$tot}")" "$init" "$call"
  sort "$out" | uniq -c | grep -v ' OK$' | sed 's/^/                                       /' || true
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

  local -a sids=() protos=()
  local s p pair
  if [[ "$mode" == "reuse" ]]; then
    local want=1
    [[ "$share" == "distinct" ]] && want=$conc
    for ((w = 0; w < want; w++)); do
      pair=$(setup_session)
      if [[ -z "$pair" ]]; then
        for ((i = 0; i < ${#sids[@]}; i++)); do close_session "${sids[$i]}" "${protos[$i]}"; done
        printf '%-34s %s\n' "$label" "SETUP_FAILED — could not establish a session (twice)"
        return 0
      fi
      read -r s p <<<"$pair"
      sids+=("$s")
      protos+=("$p")
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

  for ((i = 0; i < ${#sids[@]}; i++)); do close_session "${sids[$i]}" "${protos[$i]}"; done
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
run_sdk_arm "A  SDK client,   fresh, conc 4" fresh 4
sleep 10
run_arm "B  synthetic, ONE shared, serial" reuse 1 shared
sleep 10
run_arm "C  synthetic, ONE shared, conc 2" reuse 2 shared
sleep 10
run_arm "D  synthetic, ONE shared, conc 3" reuse 3 shared
sleep 10
run_arm "E  synthetic, ONE shared, conc 4" reuse 4 shared
sleep 10
run_sdk_arm "F  SDK client,   fresh, serial" fresh 1
sleep 10
run_sdk_arm "G  SDK client,   handshake only" initonly 4
sleep 10
run_arm "H  synthetic, session/worker, c4" reuse 4 distinct
echo
echo "A vs F isolates concurrency for the REAL SDK client.  B/C/D/E sweep concurrency"
echo "on ONE shared session (synthetic HTTP): B vs E decides whether pooling would help,"
echo "C and D locate where failures begin.  E vs H separates one-session-in-parallel from"
echo "many.  G tests the SDK handshake alone.  Rates/requests are n/a for SDK arms."
echo
echo "Note: 'eff' is the effective concurrency actually reached. Rates are HTTP"
echo "requests/min, not ops/min — modes differ in requests per operation."
