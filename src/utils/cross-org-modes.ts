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
 * - A published foreign ELEMENT is held to the same shape rules the admin PUT
 *   enforces (`validatePromptMode`); one that fails is logged and skipped,
 *   never merged, because the DO dereferences it downstream (see
 *   `foreignModeShapeError`).
 * - At most `MAX_FOREIGN_ORGS_PER_TURN` foreign keys are read per turn, taken
 *   in sorted key order BEFORE any key is read. An org whose key sorts beyond
 *   that window is INVISIBLE on the chat path — its published modes are never
 *   merged and a `selected_mode` naming one of them resolves to no mode. The
 *   drop is logged with the key names. For larger tenant counts the follow-up
 *   is an index of publishing orgs, not a larger cap.
 */
import type { ChatMode, ChatOrgModes, OrgModes, PromptMode } from '../types/prompt-overrides.js';
import { validatePromptMode } from '../types/prompt-overrides.js';
import type { RequestLogger } from './logger.js';
import { MCP_GLOBAL_KEY } from './mcp-validation.js';

/** Suffix of the per-org modes key in PROMPT_OVERRIDES: `${org}:modes`. */
const MODES_KEY_SUFFIX = ':modes';

/** Upper bound on `kv.list` pages when enumerating `*:modes` keys (mirrors MAX_LEGACY_KEY_PAGES). */
export const MAX_MODES_KEY_PAGES = 10;

/**
 * Upper bound on foreign orgs read per chat turn. Every foreign read is one
 * KV operation inside the request's per-invocation budget, so the fan-out is
 * capped by org count, not just by list pages.
 *
 * The cap is applied to the RAW sorted `*:modes` key list before any key is
 * read, so it is deterministic — and so draft-only and empty orgs count
 * against it just like publishing ones. Consequence, stated plainly: an org
 * whose key sorts beyond the window is invisible on the chat path for every
 * user. Its published modes are never merged, and a user whose persisted
 * `selected_mode` names one of them gets no mode (the selection is left in
 * storage, not cleared). `capForeignKeys` logs the dropped key names as
 * `cross_org_modes_foreign_capped` so the invisible org can be found in logs.
 *
 * When tenant count approaches this number, the follow-up is an index of
 * PUBLISHING orgs (so only orgs that have something to merge cost a read),
 * NOT a larger cap — the cap exists to bound KV operations per invocation.
 */
export const MAX_FOREIGN_ORGS_PER_TURN = 50;

/** How many dropped key names the capped warn carries; enough to name the invisible org, bounded so the log line is. */
const MAX_DROPPED_KEYS_LOGGED = 20;

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

/** The PROMPT_OVERRIDES key holding `org`'s modes. Exact, unnormalized: `' PBT'` and `'PBT'` are different keys. */
export function modesKey(org: string): string {
  return `${org}${MODES_KEY_SUFFIX}`;
}

/** Structural check for a stored `{ modes: [...] }` record. */
export function isOrgModes(value: unknown): value is OrgModes {
  return (
    value !== null &&
    typeof value === 'object' &&
    Array.isArray((value as { modes?: unknown }).modes)
  );
}

/** Why an enumerated org is not mergeable, or null when it is. */
export function orgSkipReason(org: string, slug: string): 'reserved' | 'empty_slug' | null {
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
export function isModeRecord(mode: unknown): mode is PromptMode {
  return mode !== null && typeof mode === 'object';
}

/**
 * Make stored mode elements safe to dereference on the chat path. The home
 * record reaches the DO unvalidated (only the container shape is checked), and
 * a manual KV write can leave a null, a primitive, a non-string `name` or a
 * non-array `aliases` there; `isModeVisible`, the classifier and
 * `findModeBySlug` would then throw on every turn. Skips non-objects and
 * elements without a string `name`; treats a non-array `aliases` (`null`
 * included) as none and drops non-string alias entries. Never mutates the
 * stored elements. Shared by the chat path's home read and the share-code
 * endpoint, so both see the same list.
 */
export function sanitizeModeElements(elements: readonly unknown[]): {
  modes: ChatMode[];
  dropped: number;
  aliasesReset: number;
} {
  const modes: ChatMode[] = [];
  let dropped = 0;
  let aliasesReset = 0;
  for (const element of elements) {
    if (!isModeRecord(element) || typeof element.name !== 'string') {
      dropped++;
      continue;
    }
    const { aliases, ...rest } = element as ChatMode;
    if (Array.isArray(aliases)) {
      const kept = aliases.filter((a: unknown): a is string => typeof a === 'string');
      if (kept.length !== aliases.length) aliasesReset++;
      modes.push({ ...rest, aliases: kept });
    } else {
      if (aliases !== undefined) aliasesReset++;
      modes.push(rest);
    }
  }
  return { modes, dropped, aliasesReset };
}

/** The merge's org order (first wins on a collision): plain code-unit order of raw org names. */
export function compareOrgs(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Why a published foreign element must not be merged, or null when it is
 * mergeable. An element that is an object is NOT enough: a manual KV write
 * can leave a shape the admin PUT (`validatePromptMode`) would have rejected,
 * and the DO dereferences the merged mode without re-checking it —
 * `overrides: null` makes `getEffectiveOverrides` return null (it tests
 * `!== undefined`) so `resolvePromptOverrides` throws on EVERY later turn for
 * a user whose `selected_mode` names the mode; `welcome_message: 1` makes
 * `maybeBuildModeWelcome` throw on `.trim()` at first contact. So the guard
 * reuses the storage validator verbatim (name pattern, optional-string
 * fields, boolean flags, `aliases` string[], exactly one of a plain-object
 * `overrides` / string `document`), plus an explicit `name` check because
 * `validatePromptMode` only validates `name` when the key is present.
 */
function foreignModeShapeError(mode: PromptMode): string | null {
  if (typeof mode.name !== 'string') return 'Mode name must be a string';
  return validatePromptMode(mode);
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
  for (const alias of mode.aliases ?? []) {
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
 * Append one foreign org's PUBLISHED, well-shaped modes to `modes`, qualified.
 * Drafts are dropped before the shape check (they never reach the chat path,
 * so a malformed draft is not worth a log line); a published element that
 * fails `foreignModeShapeError` is logged and skipped.
 */
function mergeForeignOrg(
  entry: { org: string; slug: string; modes: PromptMode[] },
  modes: ChatMode[],
  claimed: ClaimedNames,
  logger: RequestLogger
): void {
  const { org, slug } = entry;
  for (const [index, mode] of entry.modes.entries()) {
    if (!isModeRecord(mode)) {
      logger.warn('cross_org_modes_invalid_shape', { org, index, reason: 'mode_not_object' });
      continue;
    }
    if (mode.published !== true) continue;
    const shapeError = foreignModeShapeError(mode);
    if (shapeError !== null) {
      logger.warn('cross_org_modes_invalid_shape', {
        org,
        index,
        name: mode.name,
        reason: shapeError,
      });
      continue;
    }
    const qualified = qualifyForeignMode(mode, { org, slug }, claimed, logger);
    if (qualified !== null) modes.push(qualified);
  }
}

/**
 * The merged list plus which org claimed each qualified name/alias (first in
 * sorted org order). The share-code endpoint (admin-portal#345) reads `claimed`
 * to name a collision winner; the chat path only needs `modes`.
 */
export interface CrossOrgMergeDetail extends ChatOrgModes {
  /** Qualified name or alias → raw org name that claimed it. */
  claimed: ReadonlyMap<string, string>;
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
  return { modes: mergeCrossOrgModesDetailed(home, foreign, logger).modes };
}

/** `mergeCrossOrgModes` with its claim decisions exposed. Same code path. */
export function mergeCrossOrgModesDetailed(
  home: OrgModes,
  foreign: ForeignOrgModes[],
  logger: RequestLogger
): CrossOrgMergeDetail {
  const modes: ChatMode[] = [...home.modes];
  // Home names are bare and MODE_NAME_PATTERN forbids `/`, so only qualified
  // names can ever collide with each other.
  const claimed: ClaimedNames = new Map();
  const sorted = [...foreign].sort((a, b) => compareOrgs(a.org, b.org));

  for (const { org, modes: orgModes } of sorted) {
    const slug = orgSlug(org);
    const reason = orgSkipReason(org, slug);
    if (reason !== null) {
      logger.warn('cross_org_modes_org_skipped', { org, reason });
      continue;
    }
    mergeForeignOrg({ org, slug, modes: orgModes }, modes, claimed, logger);
  }
  return { modes, claimed };
}

/**
 * Sort the foreign keys and keep at most MAX_FOREIGN_ORGS_PER_TURN. Every key
 * beyond the window belongs to an org that is invisible this turn (see the
 * constant's doc), so the warn names them — up to MAX_DROPPED_KEYS_LOGGED —
 * alongside the full count.
 */
function capForeignKeys(keys: string[], logger: RequestLogger): string[] {
  // TODO(review): accepted interim (2026-10-21). This slices the RAW key list before
  // any value is read, so an org past the window is invisible on chat, and the
  // prefix-less kv.list() in listForeignModesKeys can drop keys before this runs.
  // Both are replaced by an index of publishing orgs in issue #459.
  const sorted = [...keys].sort();
  if (sorted.length <= MAX_FOREIGN_ORGS_PER_TURN) return sorted;
  const dropped = sorted.slice(MAX_FOREIGN_ORGS_PER_TURN);
  logger.warn('cross_org_modes_foreign_capped', {
    total: sorted.length,
    cap: MAX_FOREIGN_ORGS_PER_TURN,
    dropped_count: dropped.length,
    dropped: dropped.slice(0, MAX_DROPPED_KEYS_LOGGED),
  });
  return sorted.slice(0, MAX_FOREIGN_ORGS_PER_TURN);
}

/** Outcome of enumerating the foreign `*:modes` keys. */
interface ForeignKeyListing {
  keys: string[];
  /** The listing threw; `keys` is empty and the turn is home-only. */
  failed: boolean;
  /** MAX_MODES_KEY_PAGES ran out before the listing completed. */
  truncated: boolean;
}

/**
 * Enumerate every `*:modes` key other than the home org's. Paged and bounded;
 * a listing failure is logged and yields the empty list (home-only turn).
 */
async function listForeignModesKeys(
  kv: KVNamespace,
  homeKey: string,
  logger: RequestLogger
): Promise<ForeignKeyListing> {
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
      if (result.list_complete) return { keys: names, failed: false, truncated: false };
      cursor = result.cursor;
    }
    logger.warn('cross_org_modes_list_truncated', {
      pages: MAX_MODES_KEY_PAGES,
      listed: names.length,
    });
    return { keys: names, failed: false, truncated: true };
  } catch (error) {
    logger.error('cross_org_modes_list_failed', error, { listed: names.length });
    // Degrade to the home org only — the turn must never fail on this read.
    return { keys: [], failed: true, truncated: false };
  }
}

/** Reads one KV key as JSON. */
type JsonGet = (key: string) => Promise<unknown>;

/**
 * A stored value that is not JSON. Unlike a KV transport error it is
 * permanent: retrying returns the same bytes. Kept distinct so callers that
 * must tell "retry" from "broken data" (the share-code endpoint) can.
 */
export class CorruptModesRecordError extends Error {
  readonly key: string;
  constructor(key: string, cause: unknown) {
    super(`Stored value at ${key} is not valid JSON`, { cause });
    this.name = 'CorruptModesRecordError';
    this.key = key;
  }
}

/**
 * `kv.get(key, 'json')` with the two failure kinds separated. KV parses the
 * stored text with JSON.parse, so a value that is not JSON surfaces as a
 * SyntaxError; that is rethrown as CorruptModesRecordError. Every other error
 * (transport, limits) propagates unchanged. A missing key yields null.
 */
export async function readModesJson(kv: KVNamespace, key: string): Promise<unknown> {
  try {
    return await kv.get(key, 'json');
  } catch (error) {
    if (error instanceof Error && error.name === 'SyntaxError') {
      throw new CorruptModesRecordError(key, error);
    }
    throw error;
  }
}

/**
 * Read one foreign `<org>:modes` key. A bad shape is logged and yields null; a
 * failed get is logged and yields `'read_failed'`, so a caller that needs an
 * authoritative answer can tell a transient failure from an absent record.
 */
async function readForeignModes(
  get: JsonGet,
  key: string,
  logger: RequestLogger
): Promise<ForeignOrgModes | 'read_failed' | null> {
  let value: unknown;
  try {
    value = await get(key);
  } catch (error) {
    logger.error('cross_org_modes_read_failed', error, { key });
    // Corrupt JSON is permanent bad data, skipped like any record that is not
    // a modes shape; only a transport failure is reported as retryable.
    return error instanceof CorruptModesRecordError ? null : 'read_failed';
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
  return { org: orgFromModesKey(key), modes: value.modes };
}

/** Read the home org's modes; a failure or bad shape is logged and yields an empty list. */
async function readHomeModes(
  get: JsonGet,
  homeKey: string,
  logger: RequestLogger
): Promise<OrgModes> {
  let value: unknown;
  try {
    value = await get(homeKey);
  } catch (error) {
    logger.error('org_modes_kv_read_error', error, { key: homeKey });
    return { modes: [] };
  }
  if (value === null) return { modes: [] }; // no modes configured — the normal case for most orgs
  if (!isOrgModes(value)) {
    logger.warn('org_modes_invalid_shape', { key: homeKey });
    return { modes: [] };
  }
  const { modes, dropped, aliasesReset } = sanitizeModeElements(value.modes);
  if (dropped > 0 || aliasesReset > 0) {
    logger.warn('org_modes_invalid_elements', {
      key: homeKey,
      dropped,
      aliases_reset: aliasesReset,
    });
  }
  return { modes };
}

/** Everything the chat path read, before merging, plus how the read went. */
export interface CrossOrgModeSources {
  home: OrgModes;
  /** Foreign records that were read and had a modes shape. */
  foreign: ForeignOrgModes[];
  /** Foreign keys the listing returned (home key excluded). */
  listedKeys: string[];
  /** The subset of `listedKeys` inside the per-turn cap — the only foreign keys read. */
  readKeys: string[];
  /** Keys in `readKeys` whose get threw (the chat path treats them as absent). */
  failedKeys: string[];
  listFailed: boolean;
  listTruncated: boolean;
}

/**
 * The chat path's raw read: the home get and the key listing in parallel, then
 * the capped foreign gets in parallel. Never throws.
 *
 * `prefetched` holds raw JSON values (as `kv.get(key, 'json')` returned them)
 * that the caller has already read; those keys are not read again, so a caller
 * that inspected a record answers from that same snapshot. The chat path
 * passes nothing.
 */
export async function readCrossOrgModeSources(
  kv: KVNamespace,
  homeOrg: string,
  logger: RequestLogger,
  prefetched?: ReadonlyMap<string, unknown>
): Promise<CrossOrgModeSources> {
  const get: JsonGet = async (key) =>
    prefetched?.has(key) === true ? prefetched.get(key) : readModesJson(kv, key);
  const homeKey = modesKey(homeOrg);
  const [home, listing] = await Promise.all([
    readHomeModes(get, homeKey, logger),
    listForeignModesKeys(kv, homeKey, logger),
  ]);
  const readKeys = capForeignKeys(listing.keys, logger);
  const results = await Promise.all(
    readKeys.map(async (key) => ({ key, result: await readForeignModes(get, key, logger) }))
  );
  const foreign: ForeignOrgModes[] = [];
  const failedKeys: string[] = [];
  for (const { key, result } of results) {
    if (result === 'read_failed') failedKeys.push(key);
    else if (result !== null) foreign.push(result);
  }
  return {
    home,
    foreign,
    listedKeys: listing.keys,
    readKeys,
    failedKeys,
    listFailed: listing.failed,
    listTruncated: listing.truncated,
  };
}

/** The raw org name a `<org>:modes` key belongs to. */
export function orgFromModesKey(key: string): string {
  return key.slice(0, -MODES_KEY_SUFFIX.length);
}

/**
 * The chat path's modes read: the home org's modes plus every other org's
 * published modes, merged by `mergeCrossOrgModes`. Never throws.
 */
export async function readAllPublishedModes(
  kv: KVNamespace,
  homeOrg: string,
  logger: RequestLogger
): Promise<ChatOrgModes> {
  const sources = await readCrossOrgModeSources(kv, homeOrg, logger);
  return mergeCrossOrgModes(sources.home, sources.foreign, logger);
}
