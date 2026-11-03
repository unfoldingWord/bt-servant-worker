/**
 * THE partner namespace scheme (admin-portal#354), in one place.
 *
 * A partner API key has a stable user namespace `<ns>` (`pk_<hex>`, carried
 * over on rotation). Everything the worker writes for that partner carries
 * it in one form:
 * - client_id:        `partner:<ns>`
 * - user_id / chat_id: `partner:<ns>:<id>` (so DO names are
 *   `user:<org>:partner:<ns>:<id>` / `group:<org>:partner:<ns>:<chat>[...]`)
 * - R2 audio owner segment: `partner:<ns>:<id>` (services/audio/r2-storage.ts)
 *
 * Only the worker writes this form; internal callers may not send it
 * (isReservedPartnerId). Change the scheme here and nowhere else.
 */

/** The prefix of every partner-form id. */
export const PARTNER_PREFIX = 'partner:';

/** A partner namespace: `pk_` + hex in practice; never contains ':'. */
const NAMESPACE_PATTERN = /^[A-Za-z0-9_]+$/;

/** client_id of every request made with a partner key in namespace `ns`. */
export function partnerClientId(namespace: string): string {
  return `${PARTNER_PREFIX}${namespace}`;
}

/** The prefix of every id in namespace `ns`: `partner:<ns>:`. */
export function partnerSubjectPrefix(namespace: string): string {
  return `${PARTNER_PREFIX}${namespace}:`;
}

/** A partner end-user or group id inside the worker: `partner:<ns>:<subject>`. */
export function scopePartnerSubject(key: { userNamespace: string }, subject: string): string {
  return `${partnerSubjectPrefix(key.userNamespace)}${subject}`;
}

/** True for any value in the reserved partner form (`partner:...`). */
export function isReservedPartnerId(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(PARTNER_PREFIX);
}

/** True when `id` belongs to namespace `ns` (starts with `partner:<ns>:`). */
export function isOwnedByPartner(id: string, namespace: string): boolean {
  return id.startsWith(partnerSubjectPrefix(namespace));
}

/** The namespace of a partner client_id (`partner:<ns>`), else undefined. */
export function namespaceOfClientId(clientId: string | undefined): string | undefined {
  if (!clientId?.startsWith(PARTNER_PREFIX)) return undefined;
  const namespace = clientId.slice(PARTNER_PREFIX.length);
  return NAMESPACE_PATTERN.test(namespace) ? namespace : undefined;
}

/** Split a partner-form id `partner:<ns>:<rest>` into its parts, else null. */
export function splitPartnerSubject(id: string): { namespace: string; rest: string } | null {
  if (!id.startsWith(PARTNER_PREFIX)) return null;
  const tail = id.slice(PARTNER_PREFIX.length);
  const colon = tail.indexOf(':');
  if (colon <= 0) return null;
  const namespace = tail.slice(0, colon);
  if (!NAMESPACE_PATTERN.test(namespace)) return null;
  return { namespace, rest: tail.slice(colon + 1) };
}
