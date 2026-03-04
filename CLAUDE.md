# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## CRITICAL: Ask Before Pushing to Main

**ALWAYS ask the user before pushing changes.** This is non-negotiable.

Before committing and pushing, ask:

> "Should I push this directly to main, or create a feature branch and PR?"

**Default to creating a branch and PR** unless the user explicitly says to push to main. PRs enable:

- Claude PR Review to catch issues
- Code review before deployment
- Discussion and iteration on changes
- Clean git history with context

Pushing directly to main bypasses all review mechanisms and should only be done when the user explicitly requests it.

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

**NEVER ask to merge or offer to merge a PR until the `claude-code-review` subagent has been run and all issues it reports are resolved.** Running CI alone is NOT sufficient — the code review agent must also pass.

After pushing changes to a PR:

1. Wait for CI to pass
2. Run the `claude-code-review` subagent on the PR
3. Fix ALL issues reported by the review agent (Critical, High, Medium, and Low)
4. Push fixes and re-run the `claude-code-review` subagent
5. Repeat steps 3-4 until the review agent reports no remaining issues
6. Report the clean review results to the user
7. **ASK the user** if they want to merge
8. Only merge if the user explicitly says yes

Do NOT skip or shortcut the review loop. Every push with fixes must be re-reviewed by the `claude-code-review` subagent until it passes clean.

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

## CRITICAL: Version Bumping

**After every merge to main, you MUST bump the version.** This is non-negotiable.

The version in `package.json` is the single source of truth. A `version` lifecycle hook in `package.json` runs `scripts/generate-version.mjs` to regenerate `src/generated/version.ts` and stage it automatically.

### Process

1. After merging a PR to main, bump the version on main:
   - **Patch** (`pnpm version patch`): bug fixes, documentation changes, minor tweaks
   - **Minor** (`pnpm version minor`): new features, new endpoints, behavioral changes
2. `pnpm version` automatically:
   - Updates `package.json`
   - Regenerates `src/generated/version.ts`
   - Stages both files
   - Creates a git commit and tag
3. Push the version commit and tag: `git push && git push --tags`
4. The new version flows to the health endpoint and `{{version}}` template variables

### Important

- Do NOT manually edit `src/generated/version.ts` — it is auto-generated
- Always bump version on main, not on feature branches

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
