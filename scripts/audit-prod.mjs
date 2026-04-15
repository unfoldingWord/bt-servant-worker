#!/usr/bin/env node
/**
 * Production dependency audit script.
 *
 * Replaces `pnpm audit --prod` because npm retired the v1 audit endpoints
 * (`/-/npm/v1/security/audits` and `/-/npm/v1/security/audits/quick`) on
 * 2026-04-14 with no prior notice. No released pnpm version (9.x, 10.x, or
 * 11.0.0-rc.0) queries the replacement endpoint yet — the fix is on pnpm's
 * main branch with no ETA.
 *
 * Ported from lasker-game-service's scripts/audit-prod.mjs (commit f292f75,
 * 2026-04-14) with one extension: a `--include-dev` flag that drops `--prod`
 * from the `pnpm list` invocation so dev dependencies are included in the
 * walk. This lets a single script cover both the prod-only audit (replacing
 * `pnpm audit --prod`) and the full-tree audit that PR #121 added to close
 * the dev-dep audit bypass (replacing `pnpm audit --audit-level=high`).
 *
 * The script walks the dependency tree via `pnpm list`, POSTs to the live
 * `/-/npm/v1/security/advisories/bulk` endpoint, matches each advisory's
 * vulnerable version range against the installed versions with
 * `semver.satisfies`, and exits non-zero on any finding at or above the
 * threshold (default: low).
 *
 * Remove this file and revert `package.json` `audit:prod` / `audit:all` to
 * the pnpm audit commands when a released pnpm version queries the bulk
 * endpoint.
 */

import { execFileSync } from 'node:child_process';
import { request } from 'node:https';
import semver from 'semver';

const BULK_ENDPOINT = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical'];
const DEFAULT_AUDIT_LEVEL = 'low';

function parseArgs(argv) {
  const args = { auditLevel: DEFAULT_AUDIT_LEVEL, includeDev: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--audit-level' && argv[i + 1]) {
      args.auditLevel = argv[++i];
    } else if (a.startsWith('--audit-level=')) {
      args.auditLevel = a.slice('--audit-level='.length);
    } else if (a === '--include-dev') {
      args.includeDev = true;
    }
  }
  if (!SEVERITY_ORDER.includes(args.auditLevel)) {
    console.error(
      `audit-prod: invalid --audit-level ${JSON.stringify(args.auditLevel)} (expected one of ${SEVERITY_ORDER.join(', ')})`
    );
    process.exit(2);
  }
  return args;
}

function collectDependencies(includeDev) {
  const listArgs = includeDev
    ? ['list', '--depth=Infinity', '--json']
    : ['list', '--prod', '--depth=Infinity', '--json'];
  const raw = execFileSync('pnpm', listArgs, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const projects = JSON.parse(raw);
  const versionsByName = new Map();
  const visit = (deps) => {
    if (!deps) return;
    for (const [name, info] of Object.entries(deps)) {
      if (!info || typeof info !== 'object') continue;
      const version = info.version;
      if (version && typeof version === 'string') {
        if (!versionsByName.has(name)) versionsByName.set(name, new Set());
        versionsByName.get(name).add(version);
      }
      visit(info.dependencies);
    }
  };
  for (const project of projects) {
    visit(project.dependencies);
    visit(project.devDependencies);
    visit(project.optionalDependencies);
  }
  return versionsByName;
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Accept: 'application/json',
          'User-Agent': 'bt-servant-worker-audit/1.0',
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`POST ${url} responded ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error(`Failed to parse advisory response: ${err.message}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function fetchAdvisories(versionsByName) {
  const body = {};
  for (const [name, versions] of versionsByName) {
    body[name] = Array.from(versions);
  }
  return postJson(BULK_ENDPOINT, body);
}

function severityAtLeast(severity, threshold) {
  return SEVERITY_ORDER.indexOf(severity) >= SEVERITY_ORDER.indexOf(threshold);
}

function findingsFor(advisories, versionsByName, auditLevel) {
  const findings = [];
  for (const [name, pkgAdvisories] of Object.entries(advisories)) {
    if (!Array.isArray(pkgAdvisories)) continue;
    const installed = versionsByName.get(name);
    if (!installed) continue;
    for (const advisory of pkgAdvisories) {
      if (!severityAtLeast(advisory.severity ?? 'info', auditLevel)) continue;
      const matched = [];
      for (const version of installed) {
        try {
          if (
            semver.satisfies(version, advisory.vulnerable_versions, { includePrerelease: true })
          ) {
            matched.push(version);
          }
        } catch {
          // Unparseable range (e.g. non-semver version strings) — skip silently.
        }
      }
      if (matched.length > 0) {
        findings.push({
          name,
          versions: matched,
          severity: advisory.severity ?? 'info',
          title: advisory.title ?? '(no title)',
          url: advisory.url ?? '',
          vulnerable_versions: advisory.vulnerable_versions ?? '',
        });
      }
    }
  }
  return findings;
}

function printReport(findings, auditLevel, scope) {
  if (findings.length === 0) {
    console.log(`audit-prod: no ${scope} vulnerabilities at or above "${auditLevel}".`);
    return;
  }
  const counts = SEVERITY_ORDER.reduce((acc, s) => ({ ...acc, [s]: 0 }), {});
  for (const f of findings) counts[f.severity]++;

  console.error(
    `audit-prod: found ${findings.length} ${scope} vulnerabilit${findings.length === 1 ? 'y' : 'ies'} at or above "${auditLevel}":\n`
  );
  for (const f of findings) {
    console.error(`  [${f.severity}] ${f.name}@${f.versions.join(',')} — ${f.title}`);
    console.error(`      vulnerable: ${f.vulnerable_versions}`);
    if (f.url) console.error(`      ${f.url}`);
  }
  console.error('');
  const summary = SEVERITY_ORDER.filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${s}`)
    .join(', ');
  console.error(`audit-prod summary: ${summary}`);
}

async function main() {
  const { auditLevel, includeDev } = parseArgs(process.argv.slice(2));
  const scope = includeDev ? 'production+dev' : 'production';
  const versionsByName = collectDependencies(includeDev);
  if (versionsByName.size === 0) {
    console.log(`audit-prod: no ${scope} dependencies to audit.`);
    return;
  }
  let advisories;
  try {
    advisories = await fetchAdvisories(versionsByName);
  } catch (err) {
    console.error(`audit-prod: failed to query advisory endpoint: ${err.message}`);
    process.exit(1);
  }
  const findings = findingsFor(advisories, versionsByName, auditLevel);
  printReport(findings, auditLevel, scope);
  if (findings.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`audit-prod: unexpected error: ${err.stack || err.message || err}`);
  process.exit(1);
});
