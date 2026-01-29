#!/bin/bash
# PreToolUse hook to block git commit --no-verify attempts
# This ensures precommit hooks always run

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

# Only check git commit commands
if echo "$COMMAND" | grep -qE '^git\s+commit'; then
  if echo "$COMMAND" | grep -q '\-\-no-verify'; then
    echo "BLOCKED: Do not bypass precommit hooks with --no-verify." >&2
    echo "Commit normally and fix any precommit errors." >&2
    exit 2
  fi
fi

exit 0
