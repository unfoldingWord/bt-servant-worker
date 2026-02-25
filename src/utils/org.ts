/**
 * Helpers to resolve `org` from request bodies and query params.
 *
 * Accepts both `org` (canonical) and `org_id` (legacy alias used by the
 * WhatsApp gateway and other consumers). `org` takes precedence when both
 * are present.
 */

/**
 * Resolve org from a POST request body.
 */
export function resolveOrgFromBody(
  body: { org?: string; org_id?: string },
  defaultOrg: string
): string {
  return body.org ?? body.org_id ?? defaultOrg;
}

/**
 * Resolve org from GET query params (URLSearchParams).
 */
export function resolveOrgFromParams(params: URLSearchParams, defaultOrg: string): string {
  return params.get('org') ?? params.get('org_id') ?? defaultOrg;
}
