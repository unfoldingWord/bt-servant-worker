import { describe, expect, it } from 'vitest';
import ciYml from '../../.github/workflows/ci.yml?raw';
import stagingYml from '../../.github/workflows/deploy-staging.yml?raw';
import prodYml from '../../.github/workflows/deploy.yml?raw';

/**
 * Branching model (develop = integration, main = release):
 * - CI runs for both branches.
 * - Staging deploys only from develop, and never from a PR branch (a PR
 *   branch deploy once advanced staging's DO migration past main and froze
 *   every later deploy).
 * - Production deploys only from a v* release tag that is on main.
 */
describe('workflow triggers follow the develop/main branching model', () => {
  it('CI runs on push and pull_request for develop and main', () => {
    const onBlock = ciYml.slice(ciYml.indexOf('\non:'), ciYml.indexOf('\njobs:'));
    expect(onBlock).toMatch(/push:\s*\n\s*branches: \[main, develop\]/);
    expect(onBlock).toMatch(/pull_request:\s*\n\s*branches: \[main, develop\]/);
  });

  it('staging deploys from develop only and has no pull_request trigger', () => {
    const onBlock = stagingYml.slice(stagingYml.indexOf('\non:'), stagingYml.indexOf('\njobs:'));
    expect(onBlock).not.toContain('pull_request');
    expect(onBlock).toMatch(/workflow_run:[\s\S]*branches: \[develop\]/);
    expect(stagingYml).not.toContain("github.event_name == 'pull_request'");
  });

  it('staging deploys only after CI runs triggered by a push, not by a PR whose head is develop', () => {
    // A release PR (develop → main) runs CI with head branch develop, which the
    // workflow_run branch filter also matches; without this, every merge into
    // develop deployed staging twice while a release PR was open.
    expect(stagingYml).toContain("github.event.workflow_run.event == 'push'");
  });

  it('production refuses to deploy anything but a v* tag on main, before any deploy step', () => {
    const guardAt = prodYml.indexOf('name: Require a release tag on main');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(prodYml.indexOf('wrangler-action'));
    expect(prodYml).toContain('refs/tags/v*)');
    expect(prodYml).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
    expect(prodYml).toMatch(/fetch-depth: 0/);
  });

  it('Release Source reads the PR branch from env, not inline in the script', () => {
    // A PR author picks the branch name; interpolating ${{ github.head_ref }} into
    // run: would let a crafted name inject shell commands.
    const job = ciYml.slice(ciYml.indexOf('release-source:'), ciYml.indexOf('security-audit:'));
    expect(job).toContain('HEAD_REF: ${{ github.head_ref }}');
    const script = job.slice(job.indexOf('run: |'));
    expect(script).not.toContain('${{ github.head_ref }}');
  });
});
