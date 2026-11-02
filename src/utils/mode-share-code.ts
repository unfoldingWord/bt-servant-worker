/**
 * Authoritative WhatsApp chat code for a mode (admin-portal#345).
 *
 * The portal builds QR codes and wa.me links that pre-fill `#<code>`. For a
 * mode published by an org other than the one a WhatsApp request carries, the
 * code is `<orgslug>/<slug>`, and whether it really opens that mode depends on
 * the chat path's cross-org rules: the per-turn org cap, first-wins collisions
 * between orgs whose names slug the same, skipped orgs, the exact-key home
 * comparison, and the classifier's exact → prefix → fuzzy cascade. Rather than
 * have the portal re-implement those, this module RUNS them: the chat path's
 * read (`readCrossOrgModeSources`) and merge (`mergeCrossOrgModesDetailed`),
 * the DO's option list (`chatTriggerModeOptions`), and the classifier's own
 * token resolver (`resolveTriggerToken`), which reports which option matched
 * and through which tier.
 *
 * `resolves`, `reason` and `resolved_org` come ONLY from that actual match.
 * The merge's first-wins claims and the cap are consulted solely to explain
 * WHY this org's name is not what the token opened.
 *
 * The classifier partitions tokens by `/` (`matchToken`): a bare token only
 * ever sees bare (home) names and a qualified token only qualified (foreign)
 * names. So a home target is classified against the home record alone, with
 * no cross-org read, and the home record never affects a foreign answer.
 */
import { type MatchTier, resolveTriggerToken } from '../services/classifier/index.js';
import type { ChatMode, OrgModes, PromptMode } from '../types/prompt-overrides.js';
import { chatTriggerModeOptions, findModeBySlug } from '../types/prompt-overrides.js';
import {
  compareOrgs,
  CorruptModesRecordError,
  type CrossOrgMergeDetail,
  type CrossOrgModeSources,
  isOrgModes,
  mergeCrossOrgModesDetailed,
  modesKey,
  orgFromModesKey,
  orgSkipReason,
  orgSlug,
  readCrossOrgModeSources,
  readModesJson,
  sanitizeModeElements,
} from './cross-org-modes.js';
import { type RequestLogger, withLogContext } from './logger.js';

/** Why a code does not (or cannot) open the mode. */
export type ShareCodeReason =
  | 'not_found'
  | 'draft'
  | 'requires_group'
  | 'reserved'
  | 'collision'
  | 'capped'
  | 'org_skipped'
  | 'ambiguous';

export interface ShareCodeAnswer {
  /** Token without `#`: bare slug for a home mode, `<orgslug>/<slug>` for a foreign one; null when none can be formed. */
  code: string | null;
  /** True only when the real classifier, over the real pool, selects exactly this org's mode for `#<code>`. */
  resolves: boolean;
  reason?: ShareCodeReason;
  /** Raw org name of the mode `#<code>` actually opens, when it opens one. */
  resolved_org?: string;
}

/** Why no authoritative answer could be given right now; every case is worth a retry. */
export type ShareCodeUnavailableDetail = 'list_failed' | 'read_failed' | 'listing_lag';

/**
 * Thrown when a transient read problem could change the answer. Not logged
 * where it is thrown: the route logs it once, at warn, with `detail`.
 */
export class ShareCodeUnavailableError extends Error {
  readonly detail: ShareCodeUnavailableDetail;
  readonly key: string | undefined;
  constructor(
    detail: ShareCodeUnavailableDetail,
    opts: { key?: string | undefined; cause?: unknown } = {}
  ) {
    super(detail, { cause: opts.cause });
    this.name = 'ShareCodeUnavailableError';
    this.detail = detail;
    this.key = opts.key;
  }
}

export interface ShareCodeTarget {
  /** Raw org name (the exact KV key prefix) that owns the mode. */
  org: string;
  /** The mode as stored in that org's record (canonical name). */
  mode: PromptMode;
  /** The org a WhatsApp request will carry (gateway ENGINE_ORG). */
  homeOrg: string;
  /**
   * The parsed values the caller already read, keyed by modes key: at least
   * `<org>:modes` and `<homeOrg>:modes`. The answer is computed from this
   * snapshot; those keys are not read again.
   */
  snapshot: ReadonlyMap<string, unknown>;
}

/** A WhatsApp share link opens a private chat with a non-admin user. */
const WHATSAPP_CHAT = { isGroupChat: false, isAdmin: false } as const;

/** Tag the shared reader's events so admin traffic is distinguishable from chat turns. */
const SHARE_CODE_LOG_CONTEXT = { source: 'share_code' } as const;

/** A reason decided from the stored mode alone, before any pool read. */
function staticReason(mode: PromptMode): ShareCodeReason | null {
  if (mode.published !== true) return 'draft';
  // Hidden in the private chat a share link opens.
  if (mode.requires_group === true) return 'requires_group';
  return null;
}

/** What the classifier actually selected for `#<code>`, with its provenance. */
type ActualMatch =
  | { kind: 'clear' }
  | { kind: 'none' }
  | { kind: 'mode'; name: string; tier: MatchTier; org: string };

/** Run the classifier's resolver for `code` over `pool` and say which mode, of which org, it opened. */
function matchCode(code: string, pool: ChatMode[], homeOrg: string): ActualMatch {
  // `classifyTriggers` strips the `#` and hands this same raw token to
  // `resolveTriggerToken`; a code never contains whitespace, so it is one token.
  const resolved = resolveTriggerToken(code, chatTriggerModeOptions(pool, WHATSAPP_CHAT));
  if (resolved.kind === 'clear') return { kind: 'clear' };
  if (resolved.kind === 'unmatched') return { kind: 'none' };
  const owner = pool.find((m) => m.name === resolved.match.name);
  if (owner === undefined) return { kind: 'none' };
  // Only qualified (foreign) entries are stamped with `org` by the merge; a
  // bare name is always the home org's, whatever a stored record carries.
  const org = owner.name.includes('/') && owner.org !== undefined ? owner.org : homeOrg;
  return { kind: 'mode', name: owner.name, tier: resolved.match.tier, org };
}

/** The match is this org's own mode, by its canonical name, on the exact tier. */
function isOwnExactMatch(match: ActualMatch, expected: { name: string; org: string }): boolean {
  return (
    match.kind === 'mode' &&
    match.tier === 'exact' &&
    match.name === expected.name &&
    match.org === expected.org
  );
}

/**
 * Build the answer from the actual match. `whyMissing` explains a miss when
 * the cross-org rules removed this org's name from the pool; otherwise the
 * miss is `ambiguous` (something else matched) or `not_found` (nothing did).
 */
function answerFromMatch(
  code: string,
  match: ActualMatch,
  expected: { name: string; org: string },
  whyMissing: ShareCodeReason | null
): ShareCodeAnswer {
  if (match.kind === 'clear') return { code, resolves: false, reason: 'reserved' };
  if (isOwnExactMatch(match, expected)) {
    return { code, resolves: true, resolved_org: expected.org };
  }
  const fallback: ShareCodeReason = match.kind === 'mode' ? 'ambiguous' : 'not_found';
  const answer: ShareCodeAnswer = { code, resolves: false, reason: whyMissing ?? fallback };
  if (match.kind === 'mode') answer.resolved_org = match.org;
  return answer;
}

/** Home target: a bare token only matches bare names, so the home record is the whole pool. */
function resolveHome(target: ShareCodeTarget): ShareCodeAnswer {
  const code = target.mode.name;
  const record = target.snapshot.get(modesKey(target.homeOrg)) as OrgModes;
  const pool = sanitizeModeElements(record.modes).modes;
  const match = matchCode(code, pool, target.homeOrg);
  return answerFromMatch(code, match, { name: code, org: target.org }, null);
}

/** Why this org's qualified name is absent from the pool, when the merge or the cap removed it. */
function whyForeignMissing(
  code: string,
  org: string,
  pool: { sources: CrossOrgModeSources; merged: CrossOrgMergeDetail }
): ShareCodeReason | null {
  const claimedBy = pool.merged.claimed.get(code);
  if (claimedBy !== undefined && claimedBy !== org) return 'collision';
  // Listed but beyond the per-turn cap, or past a truncated listing.
  if (!pool.sources.readKeys.includes(modesKey(org))) return 'capped';
  return null;
}

/**
 * Whether a failed foreign get could change this answer. Anything short of an
 * exact match on this org's own mode could change: the failed org may hold the
 * mode the token would really open. An own exact match can only be pre-empted
 * by a failed org that the merge would have processed first (merge order,
 * `compareOrgs`) with the same slug, since it could claim the same name.
 */
function failureCouldChange(
  answer: ShareCodeAnswer,
  target: { org: string; slug: string },
  sources: CrossOrgModeSources
): boolean {
  if (sources.failedKeys.length === 0) return false;
  if (!answer.resolves) return true;
  return sources.failedKeys
    .map(orgFromModesKey)
    .some((failed) => orgSlug(failed) === target.slug && compareOrgs(failed, target.org) < 0);
}

async function resolveForeign(
  kv: KVNamespace,
  target: ShareCodeTarget,
  slug: string,
  logger: RequestLogger
): Promise<ShareCodeAnswer> {
  const { org, homeOrg } = target;
  const code = `${slug}/${target.mode.name}`;
  const tagged = withLogContext(logger, SHARE_CODE_LOG_CONTEXT);
  const sources = await readCrossOrgModeSources(kv, homeOrg, tagged, target.snapshot);
  if (sources.listFailed) throw new ShareCodeUnavailableError('list_failed');
  // The record exists (the caller just read it), yet a COMPLETE listing does
  // not show it: KV list lag. The chat path cannot see it yet either; retry.
  if (!sources.listTruncated && !sources.listedKeys.includes(modesKey(org))) {
    throw new ShareCodeUnavailableError('listing_lag', { key: modesKey(org) });
  }
  const merged = mergeCrossOrgModesDetailed(sources.home, sources.foreign, tagged);
  const match = matchCode(code, merged.modes, homeOrg);
  const answer = answerFromMatch(
    code,
    match,
    { name: code, org },
    whyForeignMissing(code, org, { sources, merged })
  );
  if (failureCouldChange(answer, { org, slug }, sources)) {
    throw new ShareCodeUnavailableError('read_failed', { key: sources.failedKeys[0] });
  }
  return answer;
}

/**
 * Compute the authoritative share code for `target.mode`.
 *
 * Cost per call: a home target needs no read beyond the caller's snapshot. A
 * foreign target adds one key listing (paged) and up to
 * MAX_FOREIGN_ORGS_PER_TURN foreign gets, minus the keys in the snapshot.
 *
 * Throws ShareCodeUnavailableError when a transient read problem could change
 * the answer, so it is never reported as a firm `false`.
 */
export async function resolveModeShareCode(
  kv: KVNamespace,
  target: ShareCodeTarget,
  logger: RequestLogger
): Promise<ShareCodeAnswer> {
  const { org, mode } = target;
  if (org === target.homeOrg) {
    const early = staticReason(mode);
    return early === null
      ? resolveHome(target)
      : { code: mode.name, resolves: false, reason: early };
  }
  const slug = orgSlug(org);
  if (orgSkipReason(org, slug) !== null) {
    // The chat path never merges this org; an empty slug cannot even form a code.
    return {
      code: slug === '' ? null : `${slug}/${mode.name}`,
      resolves: false,
      reason: 'org_skipped',
    };
  }
  const early = staticReason(mode);
  if (early !== null) return { code: `${slug}/${mode.name}`, resolves: false, reason: early };
  return resolveForeign(kv, target, slug, logger);
}

/** Outcome of loading the records a share-code answer is computed from. */
export type ShareCodeLoad =
  | {
      kind: 'ok';
      target: ShareCodeTarget;
      /** `<homeOrg>:modes` exists and is a modes record (false is legal: empty home). */
      homeHasModes: boolean;
    }
  | { kind: 'mode_not_found' }
  | { kind: 'corrupt_record'; key: string };

/** Marker for a stored value that is not JSON. */
const CORRUPT: unique symbol = Symbol('corrupt');

/**
 * Read one snapshot key. A transport error becomes the retryable
 * ShareCodeUnavailableError('read_failed') (logged once by the route); a value
 * that is not JSON is permanent and comes back as CORRUPT.
 */
async function readSnapshotValue(
  kv: KVNamespace,
  key: string,
  logger: RequestLogger
): Promise<unknown> {
  try {
    return await readModesJson(kv, key);
  } catch (error) {
    if (error instanceof CorruptModesRecordError) {
      logger.warn('mode_share_code_corrupt_record', { key });
      return CORRUPT;
    }
    throw new ShareCodeUnavailableError('read_failed', { key, cause: error });
  }
}

/**
 * Read `<org>:modes` and `<homeOrg>:modes` once (one get when they are the same
 * key) and find the mode. The returned snapshot is what the answer is computed
 * from. An absent or corrupt home record is an empty home, exactly as the chat
 * path's `readHomeModes` treats it; a corrupt TARGET record is reported.
 */
export async function loadShareCodeTarget(
  kv: KVNamespace,
  p: { org: string; homeOrg: string; modeName: string },
  logger: RequestLogger
): Promise<ShareCodeLoad> {
  const orgKey = modesKey(p.org);
  const homeKey = modesKey(p.homeOrg);
  const keys = [...new Set([orgKey, homeKey])];
  const values = await Promise.all(keys.map((key) => readSnapshotValue(kv, key, logger)));
  const snapshot = new Map<string, unknown>(keys.map((key, i) => [key, values.at(i)]));
  const record = snapshot.get(orgKey);
  if (record === CORRUPT) return { kind: 'corrupt_record', key: orgKey };
  if (snapshot.get(homeKey) === CORRUPT) snapshot.set(homeKey, null);

  const mode = isOrgModes(record)
    ? findModeBySlug(sanitizeModeElements(record.modes).modes, p.modeName)
    : undefined;
  if (mode === undefined) return { kind: 'mode_not_found' };
  return {
    kind: 'ok',
    target: { org: p.org, mode, homeOrg: p.homeOrg, snapshot },
    homeHasModes: isOrgModes(snapshot.get(homeKey)),
  };
}

/** Workers KV rejects keys over 512 bytes; `<org>:modes` must fit. */
const MAX_KV_KEY_BYTES = 512;

/** Error message when `org` cannot name a modes key, or null when it can. */
export function invalidOrgError(org: string): string | null {
  if (org === '') return 'Org must not be empty';
  if (new TextEncoder().encode(modesKey(org)).length > MAX_KV_KEY_BYTES) {
    return `Org is too long: '<org>:modes' must be at most ${MAX_KV_KEY_BYTES} bytes`;
  }
  return null;
}
