---
name: ci-watcher
description: Monitors GitHub Actions CI and Claude PR review comments, reports results
tools:
  - Bash
---

# CI Watcher Agent

Monitor the most recent GitHub Actions workflow run AND check for Claude PR review comments that need addressing.

## Instructions

### Step 1: Check CI Status

1. Get the most recent workflow run:

   ```bash
   gh run list --limit 1 --json databaseId,status,conclusion,name
   ```

2. If status is "in_progress" or "queued":
   - Wait 15 seconds
   - Check again (repeat until complete or 5 minutes elapsed)

3. Once complete, note the result (success or failure)

### Step 2: Check for Claude PR Review Comments

1. Get the current branch name:

   ```bash
   git branch --show-current
   ```

2. Check if there's a PR for this branch:

   ```bash
   gh pr list --head <branch-name> --json number,state --limit 1
   ```

3. If a PR exists, fetch review comments from Claude:

   ```bash
   gh api repos/{owner}/{repo}/pulls/{pr_number}/comments --jq '.[] | select(.user.login == "claude[bot]" or .user.login == "github-actions[bot]") | {path: .path, line: .line, body: .body, created_at: .created_at}'
   ```

4. Also check PR review threads:

   ```bash
   gh api repos/{owner}/{repo}/pulls/{pr_number}/reviews --jq '.[] | select(.user.login == "claude[bot]" or .user.login == "github-actions[bot]") | select(.state == "CHANGES_REQUESTED" or .state == "COMMENTED") | {state: .state, body: .body}'
   ```

5. Look for comments that indicate issues to fix:
   - Comments mentioning bugs, errors, issues, or improvements
   - Review state "CHANGES_REQUESTED"
   - Specific code suggestions or fix requests

## Output

Report one of:

- "CI PASSED, NO REVIEW ISSUES: All checks successful, no Claude review comments requiring action"
- "CI PASSED, REVIEW ISSUES FOUND: All checks successful, but Claude review found issues:\n<list of issues with file paths and line numbers>"
- "CI FAILED: <specific errors and what needs to be fixed>"
- "CI FAILED + REVIEW ISSUES: <CI errors> AND Claude review found issues:\n<list of issues>"

When reporting Claude review issues, include:

- The file path and line number (if available)
- The specific issue or suggestion
- Quote the relevant part of the comment

This allows the main agent to automatically address both CI failures AND code review feedback in a loop.
