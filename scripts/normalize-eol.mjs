#!/usr/bin/env node
/**
 * One-time line-ending migration for worktrees created before `.gitattributes`
 * (`eol=lf`) was added.
 *
 * Adding `.gitattributes` only changes how Git checks files out going forward —
 * it does NOT rewrite files already on disk. So an existing clone made under
 * Git-for-Windows' default `core.autocrlf=true` keeps its CRLF files after
 * pulling this change, and `pnpm format:check` (Prettier `endOfLine: lf`) keeps
 * failing until the working tree is re-checked-out as LF. Run this once to do
 * that.
 *
 * Safe by construction: it refuses to run unless the working tree is clean, so
 * it can never discard uncommitted work. Commit or stash first, then re-run.
 *
 * `execFileSync('git', ...)` is fine on Windows (git is a real executable on
 * PATH, unlike the `pnpm` .cmd shim).
 */
import { execFileSync } from 'node:child_process';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

const status = git(['status', '--porcelain']).trim();
if (status) {
  console.error(
    'normalize-eol: working tree is not clean — commit or stash your changes first,\n' +
      'then re-run so no uncommitted work can be lost.'
  );
  process.exit(1);
}

// The index is already LF; re-stage under the new attributes (no-op if nothing
// changed), then re-materialize the working tree from the index so any stale
// CRLF files on disk are rewritten to LF. Clean-tree check above makes this safe.
git(['add', '--renormalize', '.']);
git(['checkout', '--', '.']);

console.log('normalize-eol: working tree normalized to LF. `pnpm format:check` should now pass.');
