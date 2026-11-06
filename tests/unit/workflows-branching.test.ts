import { describe, expect, it } from 'vitest';
import ciYml from '../../.github/workflows/ci.yml?raw';
import stagingYml from '../../.github/workflows/deploy-staging.yml?raw';

/**
 * Branching model (develop = integration, main = release):
 * - CI runs for both branches.
 * - Staging deploys only from develop, and never from a PR branch (a PR
 *   branch deploy once advanced staging's DO migration past main and froze
 *   every later deploy).
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
});
