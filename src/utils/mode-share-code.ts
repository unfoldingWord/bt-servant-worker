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
 * the chat home crash guard (`sanitizeModeElements`), the DO's option list
 * (`chatTriggerModeOptions`), and the classifier itself (`classifyTriggers`
 * over the whole message `#<code>`, which also reports the cascade tier).
 *
 * `resolves` and `resolved_org` come ONLY from that actual match. The foreign
 * merge's strict shape check, the cap and the merge's first-wins claims are
 * consulted solely to explain WHY this org's mode is not what it opened.
 *
 * The classifier partitions tokens by `/` (`matchToken`): a bare token only
 * ever sees bare (home) names and a qualified token only qualified (foreign)
 * names. So a home target is classified against the home record alone, with
 * no cross-org read, and the home record never affects a foreign answer.
 */
import { classifyTriggers, type MatchTier } from '../services/classifier/index.js';
import type { ChatMode, PromptMode } from '../types/prompt-overrides.js';
import { chatTriggerModeOptions } from '../types/prompt-overrides.js';
import { resolveEffectiveMode } from '../types/mode-markdown.js';
import {
  compareOrgs,
  CorruptModesRecordError,
  type CrossOrgMergeDetail,
  type CrossOrgModeSources,
  isOrgModes,
  logShareCodeFailure,
  mergeCrossOrgModesDetailed,
  modeElementError,
  modesKey,
  orgFromModesKey,
  orgSkipReason,
  orgSlug,
  readCrossOrgModeSources,
  readModesJson,
  sanitizeModeElements,
  SHARE_CODE_LOG_CONTEXT,
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
  /**
   * Present (true) on a `resolves: false` answer when a foreign read failed:
   * the reason stands, but which look-alike (if any) the code opens is
   * unknown, so `resolved_org` is omitted. `ambiguous` vs `not_found` carries
   * the same uncertainty.
   */
  resolved_org_uncertain?: true;
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
  /**
   * The stored element passes the STRICT check (`modeElementError`). Only
   * meaningful for a foreign target: the foreign merge drops elements that
   * fail it, while the home crash guard serves them.
   */
  wellShaped: boolean;
  /** The target org's record after the chat home crash guard, computed once by the loader. */
  targetModes: ChatMode[];
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

/**
 * The one place a code is spelled: the bare name for a home mode (`slug`
 * null), `<slug>/<name>` for a foreign one, and null when the org slugs to ''.
 */
function codeFor(slug: string | null, name: string): string | null {
  if (slug === null) return name;
  return slug === '' ? null : `${slug}/${name}`;
}

/** A reason decided from the stored mode alone, before any pool read. */
function staticReason(target: ShareCodeTarget, isHome: boolean): ShareCodeReason | null {
  const { mode } = target;
  // The foreign merge drops a malformed element whatever its other flags.
  if (!isHome && !target.wellShaped) return 'invalid_mode';
  if (mode.published !== true) return 'draft';
  // Hidden in the private chat a share link opens.
  if (mode.requires_group === true) return 'requires_group';
  return null;
}

/**
 * The mode chat actually opens for the message `#<code>`, with its provenance.
 * `shadowedName` is set when the classifier selected a name that chat's
 * downstream lookup (`resolveEffectiveMode`) then rejected or redirected.
 */
type ActualMatch =
  | { kind: 'clear' }
  | { kind: 'none'; shadowedName?: string }
  | {
      kind: 'mode';
      name: string;
      tier: MatchTier | undefined;
      whole: boolean;
      org: string;
      shadowedName?: string;
    };

/**
 * Send the message `#<code>` through `classifyTriggers` (leading-token
 * extraction included), then through the DO's own downstream step,
 * `resolveEffectiveMode` over the same pool (the DO's `resolveModeOverride`).
 * That lookup takes the FIRST element whose name or alias matches, so an
 * earlier draft or group-only duplicate makes chat open nothing, and an
 * earlier mode aliasing the name makes chat open that mode instead. Report
 * the mode chat opens, the classifier tier, whether the token consumed the
 * whole message, and the opened mode's owner.
 */
function matchCode(code: string, pool: ChatMode[], homeOrg: string): ActualMatch {
  const options = chatTriggerModeOptions(pool, WHATSAPP_CHAT);
  const classified = classifyTriggers(`#${code}`, {
    availableModes: options,
    availableLanguages: [],
  });
  if (classified.clearMode) return { kind: 'clear' };
  const selected = classified.modeName;
  if (selected === undefined) return { kind: 'none' };
  const effective = resolveEffectiveMode({ modes: pool }, selected, {
    includeUnpublished: WHATSAPP_CHAT.isAdmin,
    isGroupChat: WHATSAPP_CHAT.isGroupChat,
  }).effectiveModeName;
  const shadowedName = effective === selected ? undefined : selected;
  const owner = effective === undefined ? undefined : pool.find((m) => m.name === effective);
  if (owner === undefined) return { kind: 'none', shadowedName: selected };
  const whole = classified.strippedMessage === '' && classified.unmatchedTriggers.length === 0;
  // Only qualified (foreign) entries are stamped with `org` by the merge; a
  // bare name is always the home org's, whatever a stored record carries.
  const org = owner.name.includes('/') && owner.org !== undefined ? owner.org : homeOrg;
  const tier = classified.modeMatchTier;
  const base = { kind: 'mode', name: owner.name, tier, whole, org } as const;
  return shadowedName === undefined ? base : { ...base, shadowedName };
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
  // The classifier picked this name, but an earlier element of the same pool
  // claims it in chat's first-match lookup: a collision within the record.
  const shadowed = match.shadowedName === expected.name;
  const opened: ShareCodeReason = match.kind === 'mode' ? 'ambiguous' : 'not_found';
  const fallback: ShareCodeReason = shadowed ? 'collision' : opened;
  const answer: ShareCodeAnswer = { code, resolves: false, reason: whyMissing ?? fallback };
  if (match.kind === 'mode') answer.resolved_org = match.org;
  return answer;
}

/**
 * Home target: a bare token only matches bare names, so the home record (as
 * the chat crash guard serves it) is the whole pool. Chat serves every
 * well-named home element, so a home miss is never `invalid_mode`.
 */
function resolveHome(target: ShareCodeTarget, code: string): ShareCodeAnswer {
  const match = matchCode(code, target.targetModes, target.homeOrg);
  return answerFromMatch(code, match, { name: code, org: target.org }, null);
}

/**
 * Why this org's qualified name is absent from the pool: never read (cap),
 * then claimed first by another org. (A malformed element is decided before
 * any read, in `staticReason`.)
 */
function whyForeignMissing(
  code: string,
  target: ShareCodeTarget,
  pool: { sources: CrossOrgModeSources; merged: CrossOrgMergeDetail }
): ShareCodeReason | null {
  // Listed but beyond the per-turn cap, or past a truncated listing.
  if (!pool.sources.readKeys.includes(modesKey(target.org))) return 'capped';
  // Claimed by another org first, or by another mode of THIS org whose alias
  // took the qualified name (the merge drops the later claim either way).
  if (pool.merged.claimed.has(code)) return 'collision';
  return null;
}

/**
 * Apply failed foreign reads to an answer. A failed read can only ADD
 * competitors; it can never add this org's own exact match. So `resolves` is
 * firm both ways, and on a miss only the look-alike is in doubt:
 * `resolved_org` is dropped and `resolved_org_uncertain` set. The one
 * exception is an own exact match that a failed org could have pre-empted:
 * same slug and processed first by the merge (`compareOrgs`), which throws
 * a retryable 503.
 */
function applyFailedReads(
  answer: ShareCodeAnswer,
  target: { org: string; slug: string },
  sources: CrossOrgModeSources
): ShareCodeAnswer {
  if (sources.failedKeys.length === 0) return answer;
  if (!answer.resolves) {
    const { resolved_org: _unknown, ...firm } = answer;
    return { ...firm, resolved_org_uncertain: true };
  }
  const preempted = sources.failedKeys
    .map(orgFromModesKey)
    .some((failed) => orgSlug(failed) === target.slug && compareOrgs(failed, target.org) < 0);
  if (preempted) throw new ShareCodeUnavailableError('read_failed', { key: sources.failedKeys[0] });
  return answer;
}

async function resolveForeign(
  kv: KVNamespace,
  target: ShareCodeTarget,
  p: { slug: string; code: string },
  logger: RequestLogger
): Promise<ShareCodeAnswer> {
  const { org, homeOrg } = target;
  const tagged = withLogContext(logger, SHARE_CODE_LOG_CONTEXT);
  const sources = await readCrossOrgModeSources(kv, homeOrg, logger, {
    prefetched: target.snapshot,
    source: 'share_code',
  });
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
  return applyFailedReads(answer, { org, slug: p.slug }, sources);
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
  const slug = org === target.homeOrg ? null : orgSlug(org);
  const code = codeFor(slug, mode.name);
  if (slug === null) {
    const early = staticReason(target, true);
    return early === null
      ? resolveHome(target, mode.name)
      : { code, resolves: false, reason: early };
  }
  // The chat path never merges a skipped org; an empty slug cannot even form a code.
  if (code === null || orgSkipReason(org, slug) !== null) {
    return { code, resolves: false, reason: 'org_skipped' };
  }
  const early = staticReason(target, false);
  if (early !== null) return { code, resolves: false, reason: early };
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

/** The element chat would serve among `candidates` (indexes into the sanitized list), or the first. */
function preferServed(
  candidates: number[],
  served: (index: number) => boolean
): number | undefined {
  return candidates.find(served) ?? candidates.at(0);
}

/**
 * Select the target the way chat resolves `slug`: a canonical-name match
 * beats an alias match (the classifier's exact tier checks names first), and
 * among duplicates the element chat actually serves wins. For a home org that
 * is the first one a private WhatsApp chat can see (the classifier's option
 * order); for a foreign org, the first published element that passes the
 * strict check (the one the merge keeps). The strict verdict is computed on
 * the original stored element.
 */
function selectTarget(
  elements: readonly unknown[],
  slug: string,
  isHome: boolean
): { mode: PromptMode; wellShaped: boolean; targetModes: ChatMode[] } | undefined {
  const { modes, sourceIndexes } = sanitizeModeElements(elements);
  const strictOk = (k: number): boolean => modeElementError(sourceElement(k)) === null;
  // sourceIndexes is parallel to modes; a miss is a bug, so fail loudly
  // rather than judge some other row.
  const sourceElement = (k: number): unknown => {
    const index = sourceIndexes.at(k);
    if (index === undefined || index >= elements.length) {
      throw new Error(`share-code: no source element for sanitized mode ${k}`);
    }
    return elements.at(index);
  };
  const served = (k: number): boolean => {
    const mode = modes.at(k);
    if (mode === undefined || mode.published !== true) return false;
    return isHome ? mode.requires_group !== true : strictOk(k);
  };
  const indexesWhere = (test: (m: ChatMode) => boolean): number[] =>
    modes.flatMap((m, k) => (test(m) ? [k] : []));
  const byName = indexesWhere((m) => m.name === slug);
  const chosen =
    byName.length > 0
      ? preferServed(byName, served)
      : preferServed(
          indexesWhere((m) => m.aliases?.includes(slug) === true),
          served
        );
  const mode = chosen === undefined ? undefined : modes.at(chosen);
  if (chosen === undefined || mode === undefined) return undefined;
  return { mode, wellShaped: strictOk(chosen), targetModes: modes };
}

/** The home read's failure, when the home is a separate key that could not be used. */
function homeReadFailure(
  snapshot: ReadonlyMap<string, unknown>,
  homeKey: string,
  error: unknown
): { key: string; error: unknown } | undefined {
  const value = snapshot.get(homeKey);
  return value === UNREADABLE || value === CORRUPT ? { key: homeKey, error } : undefined;
}

/**
 * The outcome for a target record that is not usable data: 500 for a value
 * that is not JSON or is JSON of the wrong shape, a retryable 503 for a
 * transport error (thrown). Undefined when the record is missing or usable.
 */
function badTargetOutcome(
  record: unknown,
  target: { key: string; error: unknown }
): ShareCodeLoad | undefined {
  if (record === UNREADABLE) {
    throw new ShareCodeUnavailableError('read_failed', { key: target.key, cause: target.error });
  }
  if (record === CORRUPT || (record !== null && !isOrgModes(record))) {
    return { kind: 'corrupt_record', key: target.key };
  }
  return undefined;
}

/**
 * Read `<org>:modes` and `<homeOrg>:modes` once (one get when they are the same
 * key) and select the mode; the answer is computed from this snapshot. A home
 * record that cannot be used (a separate key) is logged at warn as
 * `mode_share_code_home_read_failed` on every path, 404 included, and then
 * treated as an empty home with `home_has_modes` unknown, exactly as the chat
 * path degrades; a home record never affects a qualified token.
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

  const homeFailure =
    orgKey === homeKey ? undefined : homeReadFailure(snapshot, homeKey, reads.at(1)?.error);
  if (homeFailure !== undefined) {
    logShareCodeFailure(logger, 'mode_share_code_home_read_failed', homeFailure.error, {
      key: homeKey,
    });
    snapshot.set(homeKey, null);
  }

  const record = snapshot.get(orgKey);
  const bad = badTargetOutcome(record, { key: orgKey, error: reads.at(0)?.error });
  if (bad !== undefined) return bad;
  const found = isOrgModes(record)
    ? selectTarget(record.modes, p.modeName, orgKey === homeKey)
    : undefined;
  if (found === undefined) return { kind: 'mode_not_found' };
  return {
    kind: 'ok',
    target: { org: p.org, homeOrg: p.homeOrg, snapshot, ...found },
    homeHasModes: homeFailure === undefined ? isOrgModes(snapshot.get(homeKey)) : undefined,
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
