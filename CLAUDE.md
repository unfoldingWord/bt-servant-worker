# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## CRITICAL: Never Deploy Directly

**NEVER run `wrangler deploy` directly.** This is non-negotiable.

All deployments MUST go through the CI/CD pipeline:

1. Commit changes to git
2. Push to a branch
3. Create a PR
4. Wait for CI to pass
5. Get approval and merge
6. CI will deploy automatically

Deploying directly bypasses:

- Tests that catch bugs
- Code review that catches issues
- The audit trail of what's deployed
- Rollback capability via git history

The ONLY exception is if the user explicitly asks you to deploy directly for emergency hotfixes.

## CRITICAL: Never Merge Without Permission

**NEVER merge a PR without explicit user approval.** This is non-negotiable.

After pushing changes to a PR:

1. Wait for CI to pass
2. Wait for Claude PR Review to complete
3. Report the results to the user
4. **ASK the user** if they want to merge
5. Only merge if the user explicitly says yes

Merging without permission bypasses:

- The user's ability to review changes
- Claude's automated review findings
- CI checks that may catch issues
- Any other stakeholders who need to approve

## CRITICAL: Git Commit Rules

1. **Commit Author**: Claude is the SOLE author. Do NOT include:
   - Co-Authored-By lines
   - Any reference to the user's name
   - Any "Generated with Claude Code" footer
   - Use `--author="Claude <claude@anthropic.com>"` on every commit
2. **Commit Messages**: ALWAYS include both a good subject AND description - neither should EVER be blank
3. **Pre-commit Must Pass**: NEVER commit if the pre-commit hook is failing. Loop until you fix all issues.
4. **No Suppression**: NEVER suppress warnings, disable linting rules, or skip checks without explicitly asking the user first
5. **No --no-verify**: NEVER use `--no-verify` or any flag to skip pre-commit hooks

## Things to Remember Before Writing Any Code

1. State how you will verify this change works (ex. tests, bash commands, browser checks, etc)
2. Write the test orchestration step first
3. Then implement the code
4. Run verification and iterate until it passes

## Project Overview

bt-servant-worker is a Cloudflare Worker that integrates with bt-servant-engine.

## Technology Stack

- Cloudflare Workers runtime
- Wrangler CLI for development and deployment

## Development Commands

- `pnpm dev` - Start local development server
- `pnpm build` - Build the worker
- `pnpm test` - Run tests
- `pnpm lint` - Run ESLint
- `pnpm format` - Format code with Prettier
- `pnpm check` - TypeScript type check
- `pnpm architecture` - Check for circular dependencies
- `wrangler deploy` - **DO NOT USE DIRECTLY** - Deployments go through CI/CD

## What to Do After a Push

After every `git push`, you MUST invoke the ci-watcher subagent to verify CI passes:

1. Invoke the ci-watcher agent using the Task tool with `subagent_type: "ci-watcher"`
2. Wait for it to report CI status
3. If CI fails, fix the issues and push again
4. Repeat until CI passes

## Responding to PR Review Comments

When Claude PR Review (or any automated/human reviewer) comments on a PR:

### Priority Levels and Required Actions

| Priority            | Action Required                                            |
| ------------------- | ---------------------------------------------------------- |
| **Critical**        | MUST fix before merge. No exceptions.                      |
| **High**            | MUST fix before merge.                                     |
| **Medium**          | MUST fix before merge. These are real issues.              |
| **Low**             | Either fix now OR add a TODO comment with issue reference. |
| **Optional/Polish** | Address if time permits, otherwise note for future.        |

### Process

1. **Read the full review** - Don't skim. Understand each issue.
2. **Assess each issue honestly** - Don't dismiss valid concerns. If unsure, err on the side of fixing.
3. **Fix all Critical/High/Medium issues** - No shortcuts. These affect security, reliability, or maintainability.
4. **For Low priority issues**, choose one:
   - Fix them (preferred if quick)
   - Add `// TODO(review): <description>` comment in the code
   - Create a GitHub issue to track it
5. **Push fixes and wait for re-review** - The reviewer may find new issues or confirm fixes.
6. **Iterate until approved** - Don't merge with unresolved medium+ issues.

## Architecture

See [docs/implementation-plan.md](docs/implementation-plan.md) for full architecture details.
