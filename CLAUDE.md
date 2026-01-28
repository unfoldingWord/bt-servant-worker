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

## Project Overview

bt-servant-worker is a Cloudflare Worker that integrates with bt-servant-engine.

## Technology Stack

- Cloudflare Workers runtime
- Wrangler CLI for development and deployment

## Development Commands

*To be documented once project setup is complete. Expected commands:*

- `wrangler dev` - Start local development server
- `wrangler deploy` - Deploy to Cloudflare

## Architecture

*To be documented as the codebase develops.*
