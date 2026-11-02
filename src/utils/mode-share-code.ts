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
 * the shared element guard (`sanitizeModeElements`), the DO's option list
 * (`chatTriggerModeOptions`), and the classifier itself (`classifyTriggers`
 * over the whole message `#<code>`, plus `resolveTriggerToken` for the tier).
 *
 * `resolves` and `resolved_org` come ONLY from that actual match. The cap,
 * the shape guard and the merge's first-wins claims are consulted solely to
 * explain WHY this org's mode is not what the message opened.
 *
 * The classifier partitions tokens by `/` (`matchToken`): a bare token only
 * ever sees bare (home) names and a qualified token only qualified (foreign)
 * names. So a home target is classified against the home record alone, with
 * no cross-org read, and the home record never affects a foreign answer.
 */
import {
  classifyTriggers,
  type MatchTier,
  resolveTriggerToken,
} from '../services/classifier/index.js';
import type { ChatMode, OrgModes, PromptMode } from '../types/prompt-overrides.js';
import { chatTriggerModeOptions, findModeBySlug } from '../types/prompt-overrides.js';
import {
  compareOrgs,
  CorruptModesRecordError,
  type CrossOrgMergeDetail,
  type CrossOrgModeSources,
  isModeRecord,
  isOrgModes,
  mergeCrossOrgModesDetailed,
  modeElementError,
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
  | 'ambiguous'
  | 'invalid_mode';

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
  /** The stored element passes the shared guard (`modeElementError`); if not, chat never sees it. */
  wellShaped: boolean;
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

/**
 * The one place a code is spelled: the bare name for a home mode (`slug`
 * null), `<slug>/<name>` for a foreign one, and null when the org slugs to ''.
 */
function codeFor(slug: string | null, name: string): string | null {
  if (slug === null) return name;
  return slug === '' ? null : `${slug}/${name}`;
}

/** A reason decided from the stored mode alone, before any pool read. */
function staticReason(mode: PromptMode): ShareCodeReason | null {
  if (mode.published !== true) return 'draft';
  // Hidden in the private chat a share link opens.
  if (mode.requires_group === true) return 'requires_group';
  return null;
}

/** What the classifier actually selected for the message `#<code>`, with its provenance. */
type ActualMatch =
  | { kind: 'clear' }
  | { kind: 'none' }
  | { kind: 'mode'; name: string; tier: MatchTier | undefined; whole: boolean; org: string };

/**
 * Send the message `#<code>` through `classifyTriggers` (leading-token
 * extraction included) and report the mode it selected, its owner org,
 * whether the token consumed the whole message, and the cascade tier.
 */
function matchCode(code: string, pool: ChatMode[], homeOrg: string): ActualMatch {
  const options = chatTriggerModeOptions(pool, WHATSAPP_CHAT);
  const classified = classifyTriggers(`#${code}`, {
    availableModes: options,
    availableLanguages: [],
  });
  if (classified.clearMode) return { kind: 'clear' };
  if (classified.modeName === undefined) return { kind: 'none' };
  const owner = pool.find((m) => m.name === classified.modeName);
  if (owner === undefined) return { kind: 'none' };
  // The tier of the same raw token, when that token was the whole code.
  const resolved = resolveTriggerToken(code, options);
  const tier =
    resolved.kind === 'matched' && resolved.match.name === owner.name
      ? resolved.match.tier
      : undefined;
  const whole = classified.strippedMessage === '' && classified.unmatchedTriggers.length === 0;
  // Only qualified (foreign) entries are stamped with `org` by the merge; a
  // bare name is always the home org's, whatever a stored record carries.
  const org = owner.name.includes('/') && owner.org !== undefined ? owner.org : homeOrg;
  return { kind: 'mode', name: owner.name, tier, whole, org };
}

/** The message opened this org's own mode, by its canonical name, on the exact tier, consuming it all. */
function isOwnExactMatch(match: ActualMatch, expected: { name: string; org: string }): boolean {
  return (
    match.kind === 'mode' &&
    match.whole &&
    match.tier === 'exact' &&
    match.name === expected.name &&
    match.org === expected.org
  );
}

/**
 * Build the answer from the actual match. `whyMissing` explains a miss when
 * this org's mode was kept out of the pool; otherwise the miss is `ambiguous`
 * (something else matched) or `not_found` (nothing did).
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
function resolveHome(target: ShareCodeTarget, code: string): ShareCodeAnswer {
  const record = target.snapshot.get(modesKey(target.homeOrg)) as OrgModes;
  const pool = sanitizeModeElements(record.modes).modes;
  const match = matchCode(code, pool, target.homeOrg);
  const whyMissing = target.wellShaped ? null : 'invalid_mode';
  return answerFromMatch(code, match, { name: code, org: target.org }, whyMissing);
}

/**
 * Why this org's qualified name is absent from the pool, most basic cause
 * first: never read (cap), then rejected by the shared shape guard, then
 * claimed first by another org.
 */
function whyForeignMissing(
  code: string,
  target: ShareCodeTarget,
  pool: { sources: CrossOrgModeSources; merged: CrossOrgMergeDetail }
): ShareCodeReason | null {
  // Listed but beyond the per-turn cap, or past a truncated listing.
  if (!pool.sources.readKeys.includes(modesKey(target.org))) return 'capped';
  if (!target.wellShaped) return 'invalid_mode';
  const claimedBy = pool.merged.claimed.get(code);
  if (claimedBy !== undefined && claimedBy !== target.org) return 'collision';
  return null;
}

/**
 * Whether a failed foreign get could change this answer. Anything short of an
 * exact match on this org's own mode could change: the failed org may hold the
 * mode the token would really open. (Narrowing this to orgs within fuzzy reach
 * of the slug would need a second edit-distance implementation, so the rule
 * stays broad.) An own exact match can only be pre-empted by a failed org that
 * the merge would have processed first (`compareOrgs`) with the same slug.
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
  p: { slug: string; code: string },
  logger: RequestLogger
): Promise<ShareCodeAnswer> {
  const { org, homeOrg } = target;
  const tagged = withLogContext(logger, SHARE_CODE_LOG_CONTEXT);
  const sources = await readCrossOrgModeSources(kv, homeOrg, tagged, target.snapshot);
  if (sources.listFailed) throw new ShareCodeUnavailableError('list_failed');
  // The record exists (the caller just read it), yet a COMPLETE listing does
  // not show it: KV list lag. The chat path cannot see it yet either; retry.
  if (!sources.listTruncated && !sources.listedKeys.includes(modesKey(org))) {
    throw new ShareCodeUnavailableError('listing_lag', { key: modesKey(org) });
  }
  const merged = mergeCrossOrgModesDetailed(sources.home, sources.foreign, tagged);
  const match = matchCode(p.code, merged.modes, homeOrg);
  const why = whyForeignMissing(p.code, target, { sources, merged });
  const answer = answerFromMatch(p.code, match, { name: p.code, org }, why);
  if (failureCouldChange(answer, { org, slug: p.slug }, sources)) {
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
  const isHome = org === target.homeOrg;
  const slug = isHome ? null : orgSlug(org);
  const code = codeFor(slug, mode.name);
  // The chat path never merges a skipped org (an empty slug cannot even form a code).
  if (slug !== null && orgSkipReason(org, slug) !== null) {
    return { code, resolves: false, reason: 'org_skipped' };
  }
  const early = staticReason(mode);
  if (early !== null) return { code, resolves: false, reason: early };
  if (slug === null || code === null) return resolveHome(target, mode.name);
  return resolveForeign(kv, target, { slug, code }, logger);
}

/** Outcome of loading the records a share-code answer is computed from. */
export type ShareCodeLoad =
  | {
      kind: 'ok';
      target: ShareCodeTarget;
      /**
       * `<homeOrg>:modes` exists and is a modes record (false is legal: empty
       * home). Undefined when a foreign target's home read failed and the
       * answer was computed, as on the chat path, with an empty home.
       */
      homeHasModes: boolean | undefined;
    }
  | { kind: 'mode_not_found' }
  | { kind: 'corrupt_record'; key: string };

/** Markers for a snapshot value that is not usable data. */
const CORRUPT: unique symbol = Symbol('corrupt');
const UNREADABLE: unique symbol = Symbol('unreadable');

/** Read one snapshot key: the value, CORRUPT (not JSON, permanent) or UNREADABLE (transport). */
async function readSnapshotValue(
  kv: KVNamespace,
  key: string
): Promise<{ value: unknown; error?: unknown }> {
  try {
    return { value: await readModesJson(kv, key) };
  } catch (error) {
    return { value: error instanceof CorruptModesRecordError ? CORRUPT : UNREADABLE, error };
  }
}

/**
 * Find `slug` in a stored `modes[]`. Well-shaped elements match by name or
 * alias (`findModeBySlug`); an element the shared guard rejects can still be
 * found by its canonical name, so the answer can say `invalid_mode` instead
 * of pretending the mode does not exist.
 */
function findStoredMode(
  elements: readonly unknown[],
  slug: string
): { mode: PromptMode; wellShaped: boolean } | undefined {
  const valid = findModeBySlug(sanitizeModeElements(elements).modes, slug);
  if (valid !== undefined) return { mode: valid, wellShaped: true };
  const raw = elements.find(
    (e): e is PromptMode => isModeRecord(e) && (e as { name?: unknown }).name === slug
  );
  return raw === undefined ? undefined : { mode: raw, wellShaped: modeElementError(raw) === null };
}

/**
 * Read `<org>:modes` and `<homeOrg>:modes` once (one get when they are the same
 * key) and find the mode; the answer is computed from this snapshot. An absent
 * or corrupt home record is an empty home, exactly as the chat path's
 * `readHomeModes` treats it, and so is a home TRANSPORT failure for a foreign
 * target (the home record cannot affect a qualified token). A transport
 * failure on the target, or on the home of a home target, is retryable.
 */
export async function loadShareCodeTarget(
  kv: KVNamespace,
  p: { org: string; homeOrg: string; modeName: string },
  logger: RequestLogger
): Promise<ShareCodeLoad> {
  const orgKey = modesKey(p.org);
  const homeKey = modesKey(p.homeOrg);
  const keys = [...new Set([orgKey, homeKey])];
  const reads = await Promise.all(keys.map((key) => readSnapshotValue(kv, key)));
  const snapshot = new Map<string, unknown>(keys.map((key, i) => [key, reads.at(i)?.value]));

  const record = snapshot.get(orgKey);
  if (record === UNREADABLE) {
    throw new ShareCodeUnavailableError('read_failed', { key: orgKey, cause: reads.at(0)?.error });
  }
  if (record === CORRUPT) return { kind: 'corrupt_record', key: orgKey };

  let homeHasModes: boolean | undefined = isOrgModes(snapshot.get(homeKey));
  if (snapshot.get(homeKey) === UNREADABLE) {
    logger.warn('mode_share_code_home_unreadable', {
      key: homeKey,
      error: String(reads.at(1)?.error),
    });
    homeHasModes = undefined;
  }
  if (snapshot.get(homeKey) === CORRUPT || snapshot.get(homeKey) === UNREADABLE) {
    snapshot.set(homeKey, null);
  }

  const found = isOrgModes(record) ? findStoredMode(record.modes, p.modeName) : undefined;
  if (found === undefined) return { kind: 'mode_not_found' };
  return {
    kind: 'ok',
    target: { org: p.org, homeOrg: p.homeOrg, snapshot, ...found },
    homeHasModes,
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
