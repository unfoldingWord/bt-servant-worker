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
 * otherwise silently serve defaults. Two KV list calls, admin path only.
 *
 * Limits: KV `list` is eventually consistent, so config written seconds ago
 * may not be seen yet; and a brand-new org with no config yet is "unknown" by
 * this definition. Both are what the create route's `allow_new_org: true`
 * override is for.
 */

/** True when `name` is exactly `org` or one of its `org:*` sub-keys. */
function isOrgKey(name: string, org: string): boolean {
  return name === org || name.startsWith(`${org}:`);
}

async function namespaceHasOrgKey(kv: KVNamespace, org: string): Promise<boolean> {
  // `prefix: org` also matches longer org ids (`pbt` vs `pbt2`), hence isOrgKey.
  const result = await kv.list({ prefix: org, limit: 1000 });
  return result.keys.some((k) => isOrgKey(k.name, org));
}

export async function orgHasConfig(
  env: { ORG_CONFIG: KVNamespace; PROMPT_OVERRIDES: KVNamespace; DEFAULT_ORG: string },
  org: string
): Promise<boolean> {
  if (org === env.DEFAULT_ORG) return true;
  const [inConfig, inOverrides] = await Promise.all([
    namespaceHasOrgKey(env.ORG_CONFIG, org),
    namespaceHasOrgKey(env.PROMPT_OVERRIDES, org),
  ]);
  return inConfig || inOverrides;
}
