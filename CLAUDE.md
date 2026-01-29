# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- `wrangler deploy` - Deploy to Cloudflare

## What to Do After a Push

After every `git push`, you MUST invoke the ci-watcher subagent to verify CI passes:

1. Invoke the ci-watcher agent using the Task tool with `subagent_type: "ci-watcher"`
2. Wait for it to report CI status
3. If CI fails, fix the issues and push again
4. Repeat until CI passes

## Architecture

See [docs/implementation-plan.md](docs/implementation-plan.md) for full architecture details.
