/**
 * Authoritative WhatsApp chat code for a mode (admin-portal#345).
 *
 * The portal builds QR codes and wa.me links that pre-fill `#<code>`. For a
 * mode published by an org other than the one a WhatsApp request carries, the
 * code is `<orgslug>/<slug>`, and whether it really opens that mode depends on
 * the chat path's cross-org rules: the per-turn org cap, first-wins collisions
 * between orgs whose names slug the same, skipped orgs, the exact-key home
 * comparison, and the classifier's exact → prefix → fuzzy cascade. Rather than
 * have the portal re-implement those, this module answers by RUNNING them:
 * the same read (`readCrossOrgModeSources`), the same merge
 * (`mergeCrossOrgModesDetailed`), the same option list the DO hands the
 * classifier (`chatTriggerModeOptions`), and the real `classifyTriggers` over
 * `#<code>`. Nothing here decides resolution on its own; the extra fields only
 * explain a `false`.
 *
 * The classifier partitions tokens by `/` (`matchToken`): a bare token only
 * ever sees bare (home) names and a qualified token only qualified (foreign)
 * names. So a home target is classified against the home record alone, with
 * no cross-org read, and the home record never affects a foreign answer.
 */
import { classifyTriggers } from '../services/classifier/index.js';
import type { ChatMode, OrgModes, PromptMode } from '../types/prompt-overrides.js';
import { chatTriggerModeOptions, findModeBySlug } from '../types/prompt-overrides.js';
import {
  CorruptModesRecordError,
  type CrossOrgMergeDetail,
  type CrossOrgModeSources,
  isModeRecord,
  isOrgModes,
  mergeCrossOrgModesDetailed,
  modesKey,
  orgFromModesKey,
  orgSkipReason,
  orgSlug,
  readCrossOrgModeSources,
  readModesJson,
} from './cross-org-modes.js';
import type { RequestLogger } from './logger.js';

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
  /** Raw org name of the mode `#<code>` actually opens (this org when it resolves; the winner otherwise). */
  resolved_org?: string;
}

/** Why no authoritative answer could be given right now; every case is worth a retry. */
export type ShareCodeUnavailableDetail = 'list_failed' | 'read_failed' | 'listing_lag';

/** Thrown when the chat-path read degraded in a way that could change the answer. */
export class ShareCodeUnavailableError extends Error {
  readonly detail: ShareCodeUnavailableDetail;
  constructor(detail: ShareCodeUnavailableDetail) {
    super(detail);
    this.name = 'ShareCodeUnavailableError';
    this.detail = detail;
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
   * The parsed values the caller already read, keyed by
   * modes key: at least `<org>:modes` and `<homeOrg>:modes`. The answer is
   * computed from this snapshot; those keys are not read again.
   */
  snapshot: ReadonlyMap<string, unknown>;
}

/** The would-be code, or null when no token can be formed (empty org slug). */
function wouldBeCode(target: ShareCodeTarget): string | null {
  if (target.org === target.homeOrg) return target.mode.name;
  const slug = orgSlug(target.org);
  return slug === '' ? null : `${slug}/${target.mode.name}`;
}

/** A reason decided from the stored mode alone, before any pool read. */
function staticReason(target: ShareCodeTarget): ShareCodeReason | null {
  if (target.mode.published !== true) return 'draft';
  // WhatsApp share links open a private chat, where requires_group modes are hidden.
  if (target.mode.requires_group === true) return 'requires_group';
  if (target.org !== target.homeOrg && orgSkipReason(target.org, orgSlug(target.org)) !== null) {
    return 'org_skipped';
  }
  return null;
}

/**
 * The one sanitizer for every record this endpoint looks up or matches against.
 * The home record reaches the chat path unvalidated, and a manual KV write can
 * leave anything in `modes[]`. Skips non-objects and elements without a string
 * `name`; `aliases` that is not an array (`null` included) counts as none, and
 * non-string alias entries are dropped. Never mutates the stored elements.
 */
export function matcherSafeModes(modes: readonly unknown[]): ChatMode[] {
  const safe: ChatMode[] = [];
  for (const mode of modes) {
    if (!isModeRecord(mode) || typeof mode.name !== 'string') continue;
    const { aliases, ...rest } = mode as ChatMode;
    safe.push(
      Array.isArray(aliases)
        ? { ...rest, aliases: aliases.filter((a: unknown): a is string => typeof a === 'string') }
        : rest
    );
  }
  return safe;
}

/** What `#<code>` selects: a clear, a mode (name + raw org), or nothing. */
type MatchOutcome = 'clear' | { name: string; org: string } | null;

/**
 * Send `#<code>` through the real classifier over the pool a WhatsApp
 * recipient (non-admin, private chat) sees.
 */
function runChatMatcher(code: string, modes: readonly unknown[], homeOrg: string): MatchOutcome {
  const pool = matcherSafeModes(modes);
  const classified = classifyTriggers(`#${code}`, {
    availableModes: chatTriggerModeOptions(pool, { isGroupChat: false, isAdmin: false }),
    availableLanguages: [],
  });
  if (classified.clearMode) return 'clear';
  if (classified.modeName === undefined) return null;
  const winner = pool.find((m) => m.name === classified.modeName);
  if (winner === undefined) return null;
  // Only qualified (foreign) entries are stamped with `org` by the merge; a
  // bare name is always the home org's, whatever a stored record carries.
  const winnerOrg = winner.name.includes('/') ? winner.org : homeOrg;
  return winnerOrg === undefined ? null : { name: winner.name, org: winnerOrg };
}

/** The answer once the matcher has run: resolves, or the generic miss. */
function answerFromMatch(
  code: string,
  expected: { name: string; org: string },
  match: MatchOutcome
): ShareCodeAnswer {
  if (match === 'clear') return { code, resolves: false, reason: 'reserved' };
  if (match?.name === expected.name && match.org === expected.org) {
    return { code, resolves: true, resolved_org: expected.org };
  }
  if (match === null) return { code, resolves: false, reason: 'not_found' };
  return { code, resolves: false, reason: 'ambiguous', resolved_org: match.org };
}

/**
 * Home target: the chat path hands the home record to the DO verbatim, and a
 * bare token only matches bare names, so the home record is the whole pool.
 */
function resolveHome(target: ShareCodeTarget, code: string): ShareCodeAnswer {
  const record = target.snapshot.get(modesKey(target.homeOrg)) as OrgModes;
  const match = runChatMatcher(code, record.modes, target.homeOrg);
  return answerFromMatch(code, { name: target.mode.name, org: target.org }, match);
}

/** Refine a foreign miss with the cross-org causes: collision first, then the cap. */
function explainForeignMiss(
  answer: ShareCodeAnswer,
  code: string,
  org: string,
  pool: { sources: CrossOrgModeSources; merged: CrossOrgMergeDetail }
): ShareCodeAnswer {
  const claimedBy = pool.merged.claimed.get(code);
  if (claimedBy !== undefined && claimedBy !== org) {
    return { code, resolves: false, reason: 'collision', resolved_org: claimedBy };
  }
  if (!pool.sources.readKeys.includes(modesKey(org))) {
    // Listed but beyond the per-turn cap, or past a truncated listing.
    const capped: ShareCodeAnswer = { code, resolves: false, reason: 'capped' };
    if (answer.resolved_org !== undefined) capped.resolved_org = answer.resolved_org;
    return capped;
  }
  return answer;
}

/**
 * Whether a failed foreign get could have changed the RAW match result (before
 * any reason is refined). The merge is first-wins in sorted org order, so an
 * exact owner of `code` (the target, or a collision winner) can only be
 * pre-empted by a failed org with the same slug that sorts BEFORE it. Without
 * an exact owner the classifier fell through to prefix/fuzzy (or nothing), and
 * a look-alike could sit in any failed org.
 */
function failureCouldChange(
  raw: ShareCodeAnswer,
  target: { code: string; org: string },
  pool: { sources: CrossOrgModeSources; merged: CrossOrgMergeDetail }
): boolean {
  const failedOrgs = pool.sources.failedKeys.map(orgFromModesKey);
  if (failedOrgs.length === 0) return false;
  const slug = orgSlug(target.org);
  const canPreempt = (owner: string): boolean =>
    failedOrgs.some((failed) => orgSlug(failed) === slug && failed < owner);
  if (raw.resolves) return canPreempt(target.org);
  const claimedBy = pool.merged.claimed.get(target.code);
  return claimedBy === undefined ? true : canPreempt(claimedBy);
}

async function resolveForeign(
  kv: KVNamespace,
  target: ShareCodeTarget,
  code: string,
  logger: RequestLogger
): Promise<ShareCodeAnswer> {
  const { org, homeOrg } = target;
  const sources = await readCrossOrgModeSources(kv, homeOrg, logger, target.snapshot);
  if (sources.listFailed) throw new ShareCodeUnavailableError('list_failed');
  // The record exists (the caller just read it), yet a COMPLETE listing does
  // not show it: KV list lag. The chat path cannot see it yet either; retry.
  if (!sources.listTruncated && !sources.listedKeys.includes(modesKey(org))) {
    throw new ShareCodeUnavailableError('listing_lag');
  }
  const merged = mergeCrossOrgModesDetailed(sources.home, sources.foreign, logger);
  const pool = { sources, merged };
  const raw = answerFromMatch(
    code,
    { name: code, org },
    runChatMatcher(code, merged.modes, homeOrg)
  );
  if (failureCouldChange(raw, { code, org }, pool)) {
    throw new ShareCodeUnavailableError('read_failed');
  }
  return raw.resolves ? raw : explainForeignMiss(raw, code, org, pool);
}

/**
 * Compute the authoritative share code for `target.mode`.
 *
 * Cost per call: a home target needs no read beyond the caller's snapshot. A
 * foreign target adds one key listing (paged) and up to
 * MAX_FOREIGN_ORGS_PER_TURN foreign gets, minus the keys in the snapshot.
 *
 * Throws ShareCodeUnavailableError when a degraded read could change the
 * answer, so a transient failure is never reported as a firm `false`.
 */
export async function resolveModeShareCode(
  kv: KVNamespace,
  target: ShareCodeTarget,
  logger: RequestLogger
): Promise<ShareCodeAnswer> {
  const code = wouldBeCode(target);
  if (code === null) return { code, resolves: false, reason: 'org_skipped' };
  const early = staticReason(target);
  if (early !== null) return { code, resolves: false, reason: early };
  return target.org === target.homeOrg
    ? resolveHome(target, code)
    : resolveForeign(kv, target, code, logger);
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

/**
 * Read one snapshot key. A transport error is logged and becomes the retryable
 * ShareCodeUnavailableError('read_failed'); a value that is not JSON is
 * permanent and comes back as `'corrupt'`.
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
    logger.error('mode_share_code_read_failed', error, { key });
    throw new ShareCodeUnavailableError('read_failed');
  }
}

/** Marker for a stored value that is not JSON. */
const CORRUPT: unique symbol = Symbol('corrupt');

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
    ? findModeBySlug(matcherSafeModes(record.modes), p.modeName)
    : undefined;
  if (mode === undefined) return { kind: 'mode_not_found' };
  return {
    kind: 'ok',
    target: { org: p.org, mode, homeOrg: p.homeOrg, snapshot },
    homeHasModes: isOrgModes(snapshot.get(homeKey)),
  };
}
