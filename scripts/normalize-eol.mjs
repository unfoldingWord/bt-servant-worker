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
 * Why the sledgehammer (`git rm --cached` + `git reset --hard`)? Gentler forms
 * (`git add --renormalize .` then `git checkout -- .`, or `git checkout-index
 * -f -a`) do NOT rewrite the on-disk files: the index is already LF, so Git's
 * stat cache treats the CRLF working-tree files as up-to-date and skips them.
 * Emptying the index first forces `reset --hard` to re-materialize every tracked
 * file from HEAD through the `eol=lf` filter, which is what actually rewrites
 * CRLF -> LF on disk.
 *
 * Safety: `reset --hard` is destructive, so we refuse to run if there are any
 * real uncommitted changes. The check ignores pure CR-at-EOL differences
 * (`--ignore-cr-at-eol`) — those are exactly what we're here to fix and must not
 * block — while still blocking genuine content edits (staged or unstaged).
 * Untracked files are left untouched by both commands.
 *
 * `execFileSync('git', ...)` is fine on Windows (git is a real executable on
 * PATH, unlike the `pnpm` .cmd shim).
 */
import { execFileSync } from 'node:child_process';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

/** Run a git command for its exit code only (0 = success), swallowing output. */
function gitExitCode(args) {
  try {
    execFileSync('git', args, { stdio: 'ignore' });
    return 0;
  } catch (err) {
    return typeof err.status === 'number' ? err.status : 1;
  }
}

// Guard: block on real uncommitted work, but ignore CR-at-EOL-only differences
// (the stale CRLF worktree we're about to fix would otherwise look "dirty").
const realUnstaged = gitExitCode(['diff', '--quiet', '--ignore-cr-at-eol']) !== 0;
const realStaged = gitExitCode(['diff', '--cached', '--quiet', '--ignore-cr-at-eol']) !== 0;
if (realUnstaged || realStaged) {
  console.error(
    'normalize-eol: you have uncommitted changes beyond line endings.\n' +
      'Commit or stash them first, then re-run — this rewrites the working tree.'
  );
  process.exit(1);
}

// Force a full re-checkout so every tracked file is re-materialized as LF.
git(['rm', '--cached', '-r', '--quiet', '.']);
git(['reset', '--hard']);

// Verify — never claim success while a should-be-LF file is still CRLF. Files
// with an explicit `eol=crlf` attribute (*.bat/*.cmd/*.ps1) are intentionally
// CRLF per .gitattributes, so exclude them from the check.
const stillCrlf = git(['ls-files', '--eol'])
  .split('\n')
  .filter((line) => line.includes('w/crlf') && !line.includes('eol=crlf')).length;
if (stillCrlf > 0) {
  console.error(
    `normalize-eol: ${stillCrlf} file(s) still have CRLF after normalization. ` +
      'This is unexpected — please report it.'
  );
  process.exit(1);
}

console.log('normalize-eol: working tree normalized to LF. `pnpm format:check` should now pass.');
