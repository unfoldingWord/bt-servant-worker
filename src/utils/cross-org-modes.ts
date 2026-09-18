/**
 * Flat cross-org published-mode list for the chat path (admin-portal#336).
 *
 * Every chat turn used to read exactly one modes key, `${org}:modes`. Now the
 * worker also enumerates every other org's `<org>:modes` key and merges in
 * that org's PUBLISHED modes, with `name` and `aliases` qualified as
 * `<orgslug>/<slug>` so a user can reach them with `#pbt/obt-coach`:
 *
 * - Home (request) org modes are kept exactly as stored — bare names, drafts
 *   included — so admin test-chat previews and every existing `selected_mode`
 *   keep resolving as before.
 * - Foreign DRAFTS are dropped HERE, at the worker, so the DO's admin bypass
 *   in `isModeVisible` can never surface another org's drafts.
 * - `MODE_NAME_PATTERN` forbids `/`, so a qualified name can never collide
 *   with any stored bare name or alias; the prefix is data, not routing.
 * - Nothing is written to KV and no key is rewritten; the org slug is
 *   derived at read time only (portal #144's migration warning).
 * - Reads never fail the turn: a listing failure degrades to home-only and a
 *   bad foreign key is logged and skipped.
 */
import type { ChatMode, ChatOrgModes, OrgModes, PromptMode } from '../types/prompt-overrides.js';
import type { RequestLogger } from './logger.js';
import { MCP_GLOBAL_KEY } from './mcp-validation.js';

/** Suffix of the per-org modes key in PROMPT_OVERRIDES: `${org}:modes`. */
const MODES_KEY_SUFFIX = ':modes';

/** Upper bound on `kv.list` pages when enumerating `*:modes` keys (mirrors MAX_LEGACY_KEY_PAGES). */
export const MAX_MODES_KEY_PAGES = 10;

/**
 * Upper bound on foreign orgs read per chat turn. Every foreign read is one
 * KV operation inside the request's per-invocation budget, so the fan-out is
 * capped by org count, not just by list pages. Keys are taken in sorted order
 * so the cap is deterministic; anything beyond it is logged, never read.
 */
export const MAX_FOREIGN_ORGS_PER_TURN = 25;

/** One foreign org's stored modes, keyed by the raw org name from its KV key. */
export interface ForeignOrgModes {
  org: string;
  modes: PromptMode[];
}

/**
 * Derive the slug that prefixes a foreign org's mode names: trim, lowercase,
 * collapse every run outside `[a-z0-9]` to `-`, strip edge hyphens. Examples:
 * `Test Organization` → `test-organization`, `PBT` → `pbt`, `a/b` → `a-b`.
 * Idempotent, so a future lowercasing migration (#144) yields the same slug.
 * Returns `''` for a punctuation-only or blank name — callers skip that org.
 */
export function orgSlug(org: string): string {
  return org
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function modesKey(org: string): string {
  return `${org}${MODES_KEY_SUFFIX}`;
}

/** Structural check for a stored `{ modes: [...] }` record. */
function isOrgModes(value: unknown): value is OrgModes {
  return (
    value !== null &&
    typeof value === 'object' &&
    Array.isArray((value as { modes?: unknown }).modes)
  );
}

/** Why an enumerated org is not mergeable, or null when it is. */
function orgSkipReason(org: string, slug: string): 'reserved' | 'empty_slug' | null {
  if (org === MCP_GLOBAL_KEY) return 'reserved';
  if (slug === '') return 'empty_slug';
  return null;
}

/** Qualified names/aliases already claimed, with the org that claimed each. */
type ClaimedNames = Map<string, string>;

/**
 * A stored `modes[]` element is only typed as PromptMode; `isOrgModes` checks
 * the container, not its elements, and a manual KV write can leave a null or
 * primitive there. Such an element must be skipped, never dereferenced.
 */
function isModeRecord(mode: unknown): mode is PromptMode {
  return mode !== null && typeof mode === 'object';
}

/** The stored aliases, or `[]` (logged) when the field is present but not an array. */
function storedAliases(mode: PromptMode, org: string, logger: RequestLogger): string[] {
  if (mode.aliases === undefined) return [];
  if (Array.isArray(mode.aliases)) return mode.aliases;
  logger.warn('cross_org_modes_invalid_shape', {
    org,
    mode: mode.name,
    reason: 'aliases_not_array',
  });
  return [];
}

/**
 * Qualify one published foreign mode, or return null when its qualified name
 * is already claimed (first in sorted org order wins; the loser is logged as
 * `cross_org_mode_collision`). A colliding ALIAS drops just that alias.
 */
function qualifyForeignMode(
  mode: PromptMode,
  entry: { org: string; slug: string },
  claimed: ClaimedNames,
  logger: RequestLogger
): ChatMode | null {
  const qualifiedName = `${entry.slug}/${mode.name}`;
  const nameWinner = claimed.get(qualifiedName);
  if (nameWinner !== undefined) {
    logger.warn('cross_org_mode_collision', {
      qualified_name: qualifiedName,
      kind: 'name',
      org: entry.org,
      winner_org: nameWinner,
    });
    return null;
  }
  claimed.set(qualifiedName, entry.org);

  const aliases: string[] = [];
  for (const alias of storedAliases(mode, entry.org, logger)) {
    const qualifiedAlias = `${entry.slug}/${alias}`;
    const aliasWinner = claimed.get(qualifiedAlias);
    if (aliasWinner !== undefined) {
      logger.warn('cross_org_mode_collision', {
        qualified_name: qualifiedAlias,
        kind: 'alias',
        org: entry.org,
        winner_org: aliasWinner,
      });
      continue;
    }
    claimed.set(qualifiedAlias, entry.org);
    aliases.push(qualifiedAlias);
  }

  const qualified: ChatMode = { ...mode, name: qualifiedName, org: entry.org };
  if (mode.aliases !== undefined) qualified.aliases = aliases;
  return qualified;
}

/**
 * Merge the home org's modes (verbatim, first) with every other org's
 * published modes (qualified, in sorted org-name order). Pure; never throws.
 */
export function mergeCrossOrgModes(
  home: OrgModes,
  foreign: ForeignOrgModes[],
  logger: RequestLogger
): ChatOrgModes {
  const modes: ChatMode[] = [...home.modes];
  // Home names are bare and MODE_NAME_PATTERN forbids `/`, so only qualified
  // names can ever collide with each other.
  const claimed: ClaimedNames = new Map();
  const sorted = [...foreign].sort((a, b) => (a.org < b.org ? -1 : a.org > b.org ? 1 : 0));

  for (const { org, modes: orgModes } of sorted) {
    const slug = orgSlug(org);
    const reason = orgSkipReason(org, slug);
    if (reason !== null) {
      logger.warn('cross_org_modes_org_skipped', { org, reason });
      continue;
    }
    for (const [index, mode] of orgModes.entries()) {
      if (!isModeRecord(mode)) {
        logger.warn('cross_org_modes_invalid_shape', { org, index, reason: 'mode_not_object' });
        continue;
      }
      if (mode.published !== true) continue;
      const qualified = qualifyForeignMode(mode, { org, slug }, claimed, logger);
      if (qualified !== null) modes.push(qualified);
    }
  }
  return { modes };
}

/**
 * Enumerate every `*:modes` key other than the home org's. Paged and bounded;
 * a listing failure is logged and yields the empty list (home-only turn).
 */
/** Sort the foreign keys and keep at most MAX_FOREIGN_ORGS_PER_TURN, logging what was dropped. */
function capForeignKeys(keys: string[], logger: RequestLogger): string[] {
  const sorted = [...keys].sort();
  if (sorted.length <= MAX_FOREIGN_ORGS_PER_TURN) return sorted;
  logger.warn('cross_org_modes_foreign_capped', {
    total: sorted.length,
    cap: MAX_FOREIGN_ORGS_PER_TURN,
  });
  return sorted.slice(0, MAX_FOREIGN_ORGS_PER_TURN);
}

async function listForeignModesKeys(
  kv: KVNamespace,
  homeKey: string,
  logger: RequestLogger
): Promise<string[]> {
  const names: string[] = [];
  try {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_MODES_KEY_PAGES; page++) {
      const result = await kv.list(
        cursor === undefined ? { limit: 1000 } : { limit: 1000, cursor }
      );
      for (const { name } of result.keys) {
        if (name.endsWith(MODES_KEY_SUFFIX) && name !== homeKey) names.push(name);
      }
      if (result.list_complete) return names;
      cursor = result.cursor;
    }
    logger.warn('cross_org_modes_list_truncated', {
      pages: MAX_MODES_KEY_PAGES,
      listed: names.length,
    });
    return names;
  } catch (error) {
    logger.error('cross_org_modes_list_failed', error, { listed: names.length });
    // Degrade to the home org only — the turn must never fail on this read.
    return [];
  }
}

/** Read one foreign `<org>:modes` key; any failure or bad shape is logged and yields null. */
async function readForeignModes(
  kv: KVNamespace,
  key: string,
  logger: RequestLogger
): Promise<ForeignOrgModes | null> {
  let value: unknown;
  try {
    value = await kv.get(key, 'json');
  } catch (error) {
    logger.error('cross_org_modes_read_failed', error, { key });
    return null;
  }
  if (value === null) {
    // Listed a moment ago but gone now, or the stored value is JSON null.
    logger.warn('cross_org_modes_invalid_shape', { key, reason: 'null' });
    return null;
  }
  if (!isOrgModes(value)) {
    // Either a corrupt record or an org whose NAME ends in `:modes`, so its
    // org-level prompt-overrides key masquerades as a modes key.
    logger.warn('cross_org_modes_invalid_shape', { key, reason: 'not_modes_record' });
    return null;
  }
  return { org: key.slice(0, -MODES_KEY_SUFFIX.length), modes: value.modes };
}

/** Read the home org's modes; a failure or bad shape is logged and yields an empty list. */
async function readHomeModes(
  kv: KVNamespace,
  homeKey: string,
  logger: RequestLogger
): Promise<OrgModes> {
  let value: unknown;
  try {
    value = await kv.get(homeKey, 'json');
  } catch (error) {
    logger.error('org_modes_kv_read_error', error, { key: homeKey });
    return { modes: [] };
  }
  if (value === null) return { modes: [] }; // no modes configured — the normal case for most orgs
  if (!isOrgModes(value)) {
    logger.warn('org_modes_invalid_shape', { key: homeKey });
    return { modes: [] };
  }
  return value;
}

/**
 * The chat path's modes read: the home org's modes plus every other org's
 * published modes, merged by `mergeCrossOrgModes`. The home get and the key
 * listing run in parallel, then the foreign gets run in parallel. Never throws.
 */
export async function readAllPublishedModes(
  kv: KVNamespace,
  homeOrg: string,
  logger: RequestLogger
): Promise<ChatOrgModes> {
  const homeKey = modesKey(homeOrg);
  const [home, foreignKeys] = await Promise.all([
    readHomeModes(kv, homeKey, logger),
    listForeignModesKeys(kv, homeKey, logger),
  ]);
  const foreign = await Promise.all(
    capForeignKeys(foreignKeys, logger).map((key) => readForeignModes(kv, key, logger))
  );
  return mergeCrossOrgModes(
    home,
    foreign.filter((entry): entry is ForeignOrgModes => entry !== null),
    logger
  );
}
