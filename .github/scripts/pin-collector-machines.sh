#!/usr/bin/env bash
# Pin a collector fly app to EXACTLY ONE machine, then prove it, after every deploy.
#
# Why this exists: the Mimir pipeline runs `deltatocumulative`, which keeps each series'
# running total in the memory of the collector PROCESS that saw the delta. Fly load-balances
# requests across an app's machines with no affinity, so with two machines one isolate's
# flushes are split across two converters that both emit the same series with partial values
# and interleaved timestamps. Mimir then answers "Partial success" with
# `err-mimir-sample-out-of-order` and drops the later sample — seen on the prod collector on
# 2026-10-12 (`target_info` first, then `requests_total`). Per-isolate stream identity in the
# worker cannot fix this; only a single converter per stream can.
#
# Why here and not in fly.toml: fly.toml can set `min_machines_running` but has no maximum.
# The second machine both apps ran came from `fly deploy`'s default `--ha` on the first
# deploy, never from git. So the deploy command passes `--ha=false` and this step runs after
# it: scale to one (a no-op when already one), then fail the job if the app does not have
# exactly one machine. The verification is the gate; the scale is self-healing convenience.
#
# A stopped stray counts too: `auto_start_machines = true` would wake it on the next burst.
set -euo pipefail

app="${1:?usage: pin-collector-machines.sh <fly-app-name>}"

# Overridable so tests/test-pin-collector-machines.sh can stub it, same seam as
# check-collector-secrets.sh. A gate that cannot be exercised without a real fly org is a
# gate nobody can tell is still asserting.
FLYCTL="${FLYCTL:-flyctl}"

echo "Pinning fly app '$app' to one machine"
"$FLYCTL" scale count 1 --app "$app" --yes

machines="$("$FLYCTL" machines list --app "$app" --json)"
total="$(jq 'length' <<<"$machines")"
started="$(jq '[.[] | select(.state == "started")] | length' <<<"$machines")"
echo "  machines: $total total, $started started"

if [ "$total" -eq 1 ] && [ "$started" -eq 1 ]; then
  echo "fly app '$app' runs exactly one machine, as the Mimir pipeline requires."
  exit 0
fi

echo "::error::fly app '$app' must run exactly one machine; found $total ($started started)"
echo "The Mimir pipeline's deltatocumulative state lives in one collector process. Two"
echo "machines split an isolate's deltas across two converters, and Mimir rejects the result"
echo "as out-of-order (err-mimir-sample-out-of-order). Zero machines means the pipe is down."
echo "Fix, then re-run this workflow:"
echo "  $FLYCTL scale count 1 --app $app --yes"
echo "  $FLYCTL machines list --app $app   # exactly one, state 'started'"
exit 1
