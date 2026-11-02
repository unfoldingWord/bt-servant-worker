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
 */
import { classifyTriggers, type AvailableOption } from '../services/classifier/index.js';
import type { ChatMode, PromptMode } from '../types/prompt-overrides.js';
import { isModeVisible } from '../types/prompt-overrides.js';
import {
  mergeCrossOrgModesDetailed,
  modesKey,
  orgSkipReason,
  orgSlug,
  readCrossOrgModeSources,
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

/**
 * The mode options the classifier sees for one chat context. The DO's trigger
 * classification uses this, so the share-code check sees exactly the same list.
 */
export function chatTriggerModeOptions(
  modes: ChatMode[],
  ctx: { isGroupChat: boolean; isAdmin: boolean }
): AvailableOption[] {
  return modes
    .filter((m) => isModeVisible(m, ctx))
    .map((m) => ({ name: m.name, label: m.label, aliases: m.aliases }));
}

/** Thrown when the chat-path read degraded so far that no answer is authoritative. */
export class ShareCodeUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ShareCodeUnavailableError';
  }
}

interface ShareCodeTarget {
  /** Raw org name (the exact KV key prefix) that owns the mode. */
  org: string;
  /** The mode as stored in that org's record (canonical name). */
  mode: PromptMode;
  /** The org a WhatsApp request will carry (gateway ENGINE_ORG). */
  homeOrg: string;
}

/** The would-be code, or null when no token can be formed (empty org slug). */
function wouldBeCode(target: ShareCodeTarget): string | null {
  if (target.org === target.homeOrg) return target.mode.name;
  const slug = orgSlug(target.org);
  return slug === '' ? null : `${slug}/${target.mode.name}`;
}

/** A reason decided from the stored mode alone, before any pool read. */
function staticReason(target: ShareCodeTarget, code: string | null): ShareCodeReason | null {
  if (code === null) return 'org_skipped';
  if (target.mode.published !== true) return 'draft';
  // WhatsApp share links open a private chat, where requires_group modes are hidden.
  if (target.mode.requires_group === true) return 'requires_group';
  if (target.org !== target.homeOrg && orgSkipReason(target.org, orgSlug(target.org)) !== null) {
    return 'org_skipped';
  }
  return null;
}

/**
 * Send `#<code>` through the real classifier over the pool a WhatsApp
 * recipient (non-admin, private chat) sees. Returns `'clear'` for a clear
 * token, the selected mode's name and raw org, or null when nothing matched.
 */
function runChatMatcher(
  code: string,
  modes: ChatMode[],
  homeOrg: string
): 'clear' | { name: string; org: string } | null {
  const classified = classifyTriggers(`#${code}`, {
    availableModes: chatTriggerModeOptions(modes, { isGroupChat: false, isAdmin: false }),
    availableLanguages: [],
  });
  if (classified.clearMode) return 'clear';
  if (classified.modeName === undefined) return null;
  const winner = modes.find((m) => m.name === classified.modeName);
  if (winner === undefined) return null;
  // Only qualified (foreign) entries are stamped with `org` by the merge; a
  // bare name is always the home org's, whatever a stored record carries.
  const winnerOrg = winner.name.includes('/') ? winner.org : homeOrg;
  return winnerOrg === undefined ? null : { name: winner.name, org: winnerOrg };
}

/**
 * The chat path's read and merge, from `homeOrg`'s point of view. A failed key
 * listing leaves the chat path home-only; for a foreign target that would make
 * a `false` transient rather than authoritative, so it throws instead.
 */
async function readChatPool(
  kv: KVNamespace,
  p: { homeOrg: string; isHome: boolean },
  logger: RequestLogger
) {
  const sources = await readCrossOrgModeSources(kv, p.homeOrg, logger);
  if (!p.isHome && sources.listFailed) {
    throw new ShareCodeUnavailableError('cross_org_modes_list_failed');
  }
  return { sources, merged: mergeCrossOrgModesDetailed(sources.home, sources.foreign, logger) };
}

/**
 * Compute the authoritative share code for `target.mode`. One chat-path read
 * (home get + key listing + up to MAX_FOREIGN_ORGS_PER_TURN foreign gets).
 * Throws ShareCodeUnavailableError when the key listing failed, because the
 * chat path would then be home-only and a foreign `false` would be transient.
 */
export async function resolveModeShareCode(
  kv: KVNamespace,
  target: ShareCodeTarget,
  logger: RequestLogger
): Promise<ShareCodeAnswer> {
  const { org, homeOrg } = target;
  const isHome = org === homeOrg;
  const code = wouldBeCode(target);
  const early = staticReason(target, code);
  if (code === null || early !== null) {
    return { code, resolves: false, reason: early ?? 'org_skipped' };
  }

  const { sources, merged } = await readChatPool(kv, { homeOrg, isHome }, logger);

  const match = runChatMatcher(code, merged.modes, homeOrg);
  if (match === 'clear') return { code, resolves: false, reason: 'reserved' };
  const winnerOrg = match?.org;

  const expectedName = isHome ? target.mode.name : code;
  if (match?.name === expectedName && match.org === org) {
    return { code, resolves: true, resolved_org: org };
  }
  return explainMiss({ code, isHome, org, sources, merged, winnerOrg });
}

/** Explain why `#<code>` did not select the target mode, most specific cause first. */
function explainMiss(p: {
  code: string;
  isHome: boolean;
  org: string;
  sources: Awaited<ReturnType<typeof readCrossOrgModeSources>>;
  merged: ReturnType<typeof mergeCrossOrgModesDetailed>;
  winnerOrg: string | undefined;
}): ShareCodeAnswer {
  const { code, isHome, org, sources, merged, winnerOrg } = p;
  const withWinner = (reason: ShareCodeReason): ShareCodeAnswer =>
    winnerOrg === undefined
      ? { code, resolves: false, reason }
      : { code, resolves: false, reason, resolved_org: winnerOrg };

  if (!isHome) {
    const claimedBy = merged.claimed.get(code);
    if (claimedBy !== undefined && claimedBy !== org) {
      return { code, resolves: false, reason: 'collision', resolved_org: claimedBy };
    }
    const key = modesKey(org);
    if (!sources.readKeys.includes(key)) {
      // Listed but beyond the per-turn cap, or past a truncated listing:
      // either way the chat path never reads this org.
      if (sources.listedKeys.includes(key) || sources.listTruncated) {
        return withWinner('capped');
      }
    }
  }
  return withWinner(winnerOrg === undefined ? 'not_found' : 'ambiguous');
}
