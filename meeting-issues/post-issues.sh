#!/usr/bin/env bash
#
# Generic, idempotent GitHub issue poster.
# ----------------------------------------
# Reads every *.md file in ./issues/ and creates a GitHub issue for each,
# UNLESS an open OR closed issue with the same source-marker already exists
# (so re-running only fills gaps — safe after a partial/failed run).
#
# Each issue file has simple front matter delimited by '---' lines:
#
#     ---
#     title: Concise issue title
#     labels: P0, right-diamond        # optional, comma-separated
#     ---
#     ## Problem
#     ...markdown body...
#
# A hidden marker <!-- src:<MARKER> --> is appended to every body so the
# poster can detect duplicates on later runs. MARKER defaults to the repo
# folder name + date; override with the env var below.
#
# Requirements: gh (authenticated, write access) + python3 (ships with macOS).
#
# Usage:
#   ./post-issues.sh                 # post to REPO below
#   REPO=owner/name ./post-issues.sh # override repo
#   DRY_RUN=1 ./post-issues.sh       # print what it WOULD do, post nothing
#   LABELS_ON=1 ./post-issues.sh     # apply labels (verify they exist first!)

set -uo pipefail

# ---- config (edit or override via env) ----
REPO="${REPO:-unfoldingWord/bt-servant-worker}"
MARKER="${MARKER:-btservant-sync}"     # change per meeting/batch for clean dedup
DRY_RUN="${DRY_RUN:-0}"
LABELS_ON="${LABELS_ON:-0}"
ISSUE_DIR="$(cd "$(dirname "$0")" && pwd)/issues"

command -v python3 >/dev/null || { echo "ERROR: python3 not found."; exit 1; }
[ -d "$ISSUE_DIR" ]           || { echo "ERROR: no issues/ dir at $ISSUE_DIR"; exit 1; }

if [ "$DRY_RUN" = "0" ]; then
  command -v gh >/dev/null || { echo "ERROR: gh not installed. See https://cli.github.com"; exit 1; }
  # gh uses GH_TOKEN / GITHUB_TOKEN if set (GitHub Actions); otherwise the
  # interactive login from `gh auth login` (local Mac).
  if [ -z "${GH_TOKEN:-}" ] && [ -z "${GITHUB_TOKEN:-}" ]; then
    gh auth status >/dev/null 2>&1 || { echo "ERROR: gh not authenticated. Run: gh auth login"; exit 1; }
  fi
fi

CREATED=0; SKIPPED=0; FAILED=0
TMPDIR="$(mktemp -d)"; trap 'rm -rf "$TMPDIR"' EXIT

# Pre-fetch existing issue bodies once, so dedup is one API call not N.
EXISTING="$TMPDIR/existing.txt"
if [ "$DRY_RUN" = "0" ]; then
  gh issue list --repo "$REPO" --state all --limit 200 --json number,body \
    --jq '.[] | "\(.number)\t\(.body)"' > "$EXISTING" 2>/dev/null || : > "$EXISTING"
else
  : > "$EXISTING"
fi

echo "Repo:   $REPO"
echo "Marker: $MARKER"
echo "Mode:   $([ "$DRY_RUN" = 1 ] && echo DRY-RUN || echo LIVE)   Labels: $([ "$LABELS_ON" = 1 ] && echo ON || echo off)"
echo

for f in "$ISSUE_DIR"/*.md; do
  [ -e "$f" ] || { echo "No .md files in $ISSUE_DIR"; break; }

  slug="$(basename "$f" .md)"
  bf="$TMPDIR/$slug.body"

  # Parse front matter with python3 (stdlib only). Python writes the body
  # directly to $bf and prints two lines to stdout: title, then labels.
  meta="$(python3 - "$f" "$bf" <<'PY'
import sys
src, bodyfile = sys.argv[1], sys.argv[2]
raw = open(src, encoding="utf-8").read()
title, labels, body = "", "", raw
if raw.startswith("---"):
    parts = raw.split("---", 2)
    if len(parts) == 3:
        fm, body = parts[1], parts[2]
        for line in fm.strip().splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                k, v = k.strip().lower(), v.strip()
                # strip optional surrounding quotes on the value
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                    v = v[1:-1]
                if k == "title":  title = v
                if k == "labels": labels = v
body = body.lstrip("\n")
open(bodyfile, "w", encoding="utf-8").write(body)
print(title)
print(labels)
PY
)"
  title="$(printf '%s\n' "$meta" | sed -n '1p')"
  labels="$(printf '%s\n' "$meta" | sed -n '2p')"

  if [ -z "$title" ]; then
    echo "!! SKIP (no title): $(basename "$f")"; FAILED=$((FAILED+1)); continue
  fi

  # Stable per-issue marker = MARKER + slug of filename.
  hidden="<!-- src:${MARKER}/${slug} -->"

  # Dedup: already posted if the hidden marker appears in any existing body.
  if grep -qF "$hidden" "$EXISTING" 2>/dev/null; then
    echo ".. skip (exists): $title"; SKIPPED=$((SKIPPED+1)); continue
  fi

  # Append the hidden marker to the body file.
  printf '\n%s\n' "$hidden" >> "$bf"

  # Build label args.
  label_args=()
  if [ "$LABELS_ON" = "1" ] && [ -n "$labels" ]; then
    IFS=',' read -ra LBLS <<< "$labels"
    for l in "${LBLS[@]}"; do
      l="$(echo "$l" | sed 's/^ *//;s/ *$//')"
      [ -n "$l" ] && label_args+=(--label "$l")
    done
  fi

  if [ "$DRY_RUN" = "1" ]; then
    echo "WOULD CREATE: $title"
    [ "${#label_args[@]}" -gt 0 ] && echo "        labels: ${labels}"
    CREATED=$((CREATED+1))
    continue
  fi

  if gh issue create --repo "$REPO" --title "$title" --body-file "$bf" "${label_args[@]}"; then
    CREATED=$((CREATED+1))
  else
    echo "!! FAILED: $title" >&2; FAILED=$((FAILED+1))
  fi
done

echo
echo "Summary -> created/would-create: $CREATED   skipped(existing): $SKIPPED   failed: $FAILED"
