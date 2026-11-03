/**
 * Durable Object storage limits shared by every DO that batches its own
 * storage calls (UserDO's legacy import transfer, PartnerKeyStoreDO's ledger).
 */

/** Keys one DO storage `get` / `put` / `delete` call accepts. */
export const DO_STORAGE_MAX_KEYS_PER_CALL = 128;
