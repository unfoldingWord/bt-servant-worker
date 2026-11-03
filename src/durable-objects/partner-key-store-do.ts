/**
 * PartnerKeyStoreDO — placeholder for the partner API key store (admin-portal#354).
 *
 * This is an EMPTY stub. It exists only so that `main` declares the `v4`
 * Durable Object migration that is already applied on the staging script:
 * PR #475's branch deploy created the `PartnerKeyStoreDO` class there, and
 * Cloudflare refuses every deploy whose config does not know that migration
 * (error 10074, "Cannot rename Durable Objects from class 'UserSession' to
 * class 'UserDO'"). Until this landed, nothing but #475's own branch could
 * reach staging.
 *
 * #475 replaces this file with the real implementation. Replacing a class
 * body needs no new migration; only the class name must stay `PartnerKeyStoreDO`.
 * Nothing routes to this object yet, so the stub refuses every request.
 */
export class PartnerKeyStoreDO {
  constructor(_state: DurableObjectState, _env: unknown) {}

  fetch(_request: Request): Response {
    return Response.json(
      { error: 'PartnerKeyStoreDO is not implemented yet (see admin-portal#354, worker PR #475)' },
      { status: 501 }
    );
  }
}
