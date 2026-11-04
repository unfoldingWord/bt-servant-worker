import { describe, expect, it } from 'vitest';

// Vite inlines the file as a string at build time; the Workers test runtime
// has no filesystem, so this is the only way a test can read wrangler.toml.
import wranglerToml from '../../wrangler.toml?raw';

/**
 * #479 rollout step 5: once every admin client (admin portal, baruch) sends
 * ADMIN_API_KEY, the flag that strips admin authority from ENGINE_API_KEY must
 * be on in every deployed environment. This pins the shipped config so a
 * later edit cannot quietly reopen the hole.
 */
describe('wrangler.toml — ADMIN_KEY_REQUIRED is enforced in every environment', () => {
  function varsBlock(header: string): string {
    const start = wranglerToml.indexOf(header);
    expect(start, `missing ${header}`).toBeGreaterThan(-1);
    const next = wranglerToml.indexOf('\n[', start + header.length);
    return wranglerToml.slice(start, next === -1 ? undefined : next);
  }

  it('production [vars] sets ADMIN_KEY_REQUIRED = "true"', () => {
    expect(varsBlock('\n[vars]')).toMatch(/ADMIN_KEY_REQUIRED\s*=\s*"true"/);
  });

  it('[env.staging.vars] sets ADMIN_KEY_REQUIRED = "true"', () => {
    expect(varsBlock('\n[env.staging.vars]')).toMatch(/ADMIN_KEY_REQUIRED\s*=\s*"true"/);
  });
});
