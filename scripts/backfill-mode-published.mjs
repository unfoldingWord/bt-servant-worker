#!/usr/bin/env node
/**
 * One-time KV backfill: stamp `published: true` on every existing mode stored at
 * `{org}:modes` in the PROMPT_OVERRIDES namespace.
 *
 * Context: issue #151 introduces a `published` flag on PromptMode. The runtime
 * filter treats `published !== true` as a draft (invisible to end users). Without
 * this backfill, every pre-existing mode would become invisible when the filter
 * ships. Idempotent: any mode that already has `published` set (either value) is
 * left untouched.
 *
 * Run BEFORE the worker PR deploys to each environment.
 *
 * Usage:
 *   node scripts/backfill-mode-published.mjs --env=staging [--dry-run]
 *   node scripts/backfill-mode-published.mjs --env=production [--dry-run]
 *
 * Optional flags:
 *   --orgs=unfoldingWord,wordcollective   (defaults to both)
 *   --dry-run                              prints planned changes, writes nothing
 *
 * Requires `wrangler` on PATH and an authenticated Cloudflare session with
 * access to the target account's PROMPT_OVERRIDES KV namespace.
 */

import { execFileSync } from 'node:child_process';

const DEFAULT_ORGS = ['unfoldingWord', 'wordcollective'];

function parseArgs(argv) {
  const args = { env: null, orgs: DEFAULT_ORGS, dryRun: false };
  for (const raw of argv) {
    if (raw.startsWith('--env=')) {
      args.env = raw.slice('--env='.length);
    } else if (raw.startsWith('--orgs=')) {
      args.orgs = raw
        .slice('--orgs='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (raw === '--dry-run') {
      args.dryRun = true;
    } else {
      console.error(`backfill-mode-published: unknown argument ${JSON.stringify(raw)}`);
      process.exit(2);
    }
  }
  if (args.env !== 'staging' && args.env !== 'production') {
    console.error('backfill-mode-published: --env=staging or --env=production is required');
    process.exit(2);
  }
  if (args.orgs.length === 0) {
    console.error('backfill-mode-published: --orgs must list at least one org');
    process.exit(2);
  }
  return args;
}

/**
 * Run a wrangler command scoped to the target environment.
 * For production we omit --env (default binding in wrangler.toml); for staging
 * we pass --env=staging so the staging KV namespace is used.
 */
function wrangler(args, env, opts = {}) {
  const full = env === 'staging' ? [...args, '--env=staging'] : args;
  return execFileSync('wrangler', full, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: opts.stdio ?? ['ignore', 'pipe', 'inherit'],
  });
}

function readModes(org, env) {
  let raw;
  try {
    raw = wrangler(
      ['kv', 'key', 'get', `${org}:modes`, '--binding=PROMPT_OVERRIDES', '--remote'],
      env
    );
  } catch (err) {
    // wrangler exits non-zero when the key is missing. Treat that as "no modes yet".
    const msg = err.stderr?.toString?.() ?? err.message ?? '';
    if (/not found|Key .* does not exist/i.test(msg)) return null;
    throw err;
  }
  if (!raw || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${org}:modes is not valid JSON: ${err.message}`);
  }
}

function writeModes(org, env, value) {
  const payload = JSON.stringify(value);
  execFileSync(
    'wrangler',
    [
      'kv',
      'key',
      'put',
      `${org}:modes`,
      payload,
      '--binding=PROMPT_OVERRIDES',
      '--remote',
      ...(env === 'staging' ? ['--env=staging'] : []),
    ],
    { encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] }
  );
}

function backfillOneOrg(org, env, dryRun) {
  const current = readModes(org, env);
  if (!current) {
    console.log(`[${env}] ${org}: no modes key present — nothing to do.`);
    return { org, stamped: 0, alreadyPublished: 0, total: 0 };
  }
  if (!Array.isArray(current.modes)) {
    throw new Error(`[${env}] ${org}: expected { modes: [...] }, got ${typeof current.modes}`);
  }
  let stamped = 0;
  let alreadyPublished = 0;
  const updated = {
    ...current,
    modes: current.modes.map((mode) => {
      if (Object.prototype.hasOwnProperty.call(mode, 'published')) {
        alreadyPublished++;
        return mode;
      }
      stamped++;
      return { ...mode, published: true };
    }),
  };
  const total = current.modes.length;
  console.log(
    `[${env}] ${org}: total=${total}, to_stamp=${stamped}, already_set=${alreadyPublished}`
  );
  if (stamped === 0) return { org, stamped, alreadyPublished, total };
  if (dryRun) {
    console.log(`[${env}] ${org}: --dry-run, not writing.`);
    return { org, stamped, alreadyPublished, total };
  }
  writeModes(org, env, updated);
  console.log(`[${env}] ${org}: wrote ${stamped} stamped mode(s).`);
  return { org, stamped, alreadyPublished, total };
}

function main() {
  const { env, orgs, dryRun } = parseArgs(process.argv.slice(2));
  console.log(`backfill-mode-published: env=${env}, orgs=[${orgs.join(', ')}], dry-run=${dryRun}`);
  const results = [];
  for (const org of orgs) {
    results.push(backfillOneOrg(org, env, dryRun));
  }
  const totals = results.reduce(
    (acc, r) => ({
      stamped: acc.stamped + r.stamped,
      alreadyPublished: acc.alreadyPublished + r.alreadyPublished,
      total: acc.total + r.total,
    }),
    { stamped: 0, alreadyPublished: 0, total: 0 }
  );
  console.log(
    `backfill-mode-published: done — total_modes=${totals.total}, stamped=${totals.stamped}, already_set=${totals.alreadyPublished}${dryRun ? ' (dry-run)' : ''}`
  );
}

main();
