/**
 * Does an org have any configuration in the worker? (admin-portal#354)
 *
 * The worker has no org registry: an org "exists" only through the config an
 * admin has stored for it. Every per-org write in src/index.ts lands on one of
 * these keys, so their presence is the signal:
 *
 *   ORG_CONFIG        <org>
 *   PROMPT_OVERRIDES  <org>, <org>:modes, <org>:languages,
 *                     <org>:language-scaffold, … (all `<org>` or `<org>:*`)
 *
 * The default org always counts (it serves the built-in defaults by design).
 * Used to refuse creating a partner key for a typo'd org, which would
 * otherwise silently serve defaults. Admin path only: two exact gets plus one
 * `list({ prefix: "<org>:", limit: 1 })`, so neither the number of keys nor
 * orgs whose ids merely start with this one (`pbt` vs `pbt2`) can affect it.
 *
 * Limits: KV `list` is eventually consistent, so `<org>:*` config written
 * seconds ago may not be seen yet; and a brand-new org with no config yet is
 * "unknown" by this definition. Both are what the create route's
 * `allow_new_org: true` override is for.
 */

export async function orgHasConfig(
  env: { ORG_CONFIG: KVNamespace; PROMPT_OVERRIDES: KVNamespace; DEFAULT_ORG: string },
  org: string
): Promise<boolean> {
  if (org === env.DEFAULT_ORG) return true;
  const [config, overrides, subKeys] = await Promise.all([
    env.ORG_CONFIG.get(org),
    env.PROMPT_OVERRIDES.get(org),
    env.PROMPT_OVERRIDES.list({ prefix: `${org}:`, limit: 1 }),
  ]);
  return config !== null || overrides !== null || subKeys.keys.length > 0;
}
