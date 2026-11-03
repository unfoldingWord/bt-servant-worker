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

/**
 * THE org check for every path that builds a conversation (Durable Object)
 * name — `user:<org>:<user_id>`, `group:<org>:<chat_id>[:<thread_id>]` — used
 * by chat bodies (validateChatBody) and the user / group routes
 * (handleDORequest). Those names join their parts with ':', so an org
 * containing ':' could rebuild another org's or a partner's name (org
 * `acme:partner` + user_id `pk_abc:u1` = partner `pk_abc`'s user `u1` in
 * `acme`). Returns the 400 message, or null. Every known org (unfoldingWord,
 * wordcollective, ...) is a plain name.
 */
export function orgDoNameError(org: unknown): string | null {
  if (typeof org === 'string' && org.includes(':')) {
    return "org must not contain ':' (it is part of conversation names)";
  }
  return null;
}
