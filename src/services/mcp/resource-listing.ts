/**
 * Aggregated MCP resource listing (worker#257 item 1).
 *
 * Fans out to every enabled MCP server, invokes its listing tool where one
 * exists, and normalizes the results into the canonical shape defined in
 * types/resources.ts. Capability is detected by the presence of a known
 * listing tool in the discovery manifest — no config flag, self-maintaining
 * as servers gain the capability. Servers without one report `unsupported`;
 * transient failures report `error` with the message. One failing server
 * never hides another's results.
 *
 * Parsers are exported separately from the fan-out so tests can exercise
 * them against captured live fixtures without any network mocking.
 */

import {
  KNOWN_SUBJECTS,
  ResourceItem,
  ResourceServerReport,
  ResourcesBySubject,
} from '../../types/resources.js';
import { RequestLogger } from '../../utils/logger.js';
import { callMCPTool, discoverAllTools } from './discovery.js';
import { MCPServerConfig, MCPServerManifest, MCPToolDefinition } from './types.js';

// ─── Subject normalization ────────────────────────────────────────────────────

/** translation-helps subject vocabulary → canonical slug. */
const TRANSLATION_HELPS_SUBJECT_MAP: Record<string, string> = {
  Bible: 'bible',
  'Aligned Bible': 'aligned-bible',
  'Translation Words': 'translation-words',
  'Translation Academy': 'translation-academy',
  'TSV Translation Notes': 'translation-notes',
  'TSV Translation Questions': 'translation-questions',
  'TSV Translation Words Links': 'translation-words-links',
};

/** aquifer display-type vocabulary → canonical slug. */
const AQUIFER_TYPE_MAP: Record<string, string> = {
  Bible: 'bible',
  'Bible Dictionary': 'dictionary',
  'Thematic Dictionary': 'dictionary',
  'Semantic Lexicon': 'lexicon',
  'Study Notes': 'study-notes',
  'Translation Guide': 'translation-notes',
  'Bible Translation Manual': 'translation-academy',
  'Translation Glossary': 'translation-words',
  'Comprehension Testing': 'translation-questions',
  'Foundational Bible Stories': 'bible-stories',
  'Images, Maps, Videos': 'media',
};

/**
 * Fallback for vocabulary terms with no mapping: lowercase kebab-case of the
 * raw term, so new server categories degrade to "visible but unknown"
 * instead of disappearing (see KNOWN_SUBJECTS doc).
 */
export function slugifySubject(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'uncategorized';
}

function normalizeSubject(raw: string, map: Record<string, string>): string {
  // Lookup in a module-const map with a server-supplied key; worst case is undefined.
  // eslint-disable-next-line security/detect-object-injection
  return map[raw] ?? slugifySubject(raw);
}

// ─── translation-helps adapter ────────────────────────────────────────────────

/**
 * Parse the JSON payload of `list_resources_for_language`. The tool returns
 * stringified JSON with the map nested under `resourcesBySubject`; items are
 * near-identity with canonical ResourceItem (no serverId, raw subject names).
 * Throws with a descriptive message on any shape mismatch — the caller
 * converts that into a per-server `error` report.
 */
function extractResourcesBySubject(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('translation-helps listing was not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('translation-helps listing JSON was not an object');
  }
  const bySubject = (parsed as { resourcesBySubject?: unknown }).resourcesBySubject;
  if (typeof bySubject !== 'object' || bySubject === null || Array.isArray(bySubject)) {
    throw new Error('translation-helps listing missing "resourcesBySubject" map');
  }
  return bySubject as Record<string, unknown>;
}

function normalizeTranslationHelpsItem(raw: unknown, serverId: string): ResourceItem {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('translation-helps listing item was not an object');
  }
  const item = raw as Record<string, unknown>;
  if (typeof item.name !== 'string' || typeof item.subject !== 'string') {
    throw new Error('translation-helps listing item missing name/subject');
  }
  const normalized: ResourceItem = {
    name: item.name,
    subject: normalizeSubject(item.subject, TRANSLATION_HELPS_SUBJECT_MAP),
    serverId,
  };
  if (typeof item.organization === 'string') normalized.organization = item.organization;
  if (typeof item.version === 'string') normalized.version = item.version;
  if (typeof item.url === 'string') normalized.url = item.url;
  return normalized;
}

export function parseTranslationHelpsListing(text: string, serverId: string): ResourceItem[] {
  const items: ResourceItem[] = [];
  for (const rawItems of Object.values(extractResourcesBySubject(text))) {
    if (!Array.isArray(rawItems)) {
      throw new Error('translation-helps listing subject value was not an array');
    }
    for (const raw of rawItems) {
      items.push(normalizeTranslationHelpsItem(raw, serverId));
    }
  }
  return items;
}

// ─── aquifer adapter ──────────────────────────────────────────────────────────

/**
 * Aquifer's `list` output is structured markdown, one entry per resource:
 *
 *   - **Display Title** (ResourceCode)
 *     Type: Study Notes | Order: canonical | Articles: 16923 | Language: eng | ...
 *
 * The header line is matched by regex; the detail line is split on `|` into
 * `Field: value` pairs. A partial/foreign format yields zero matches (and
 * then a loud declared-count mismatch) rather than garbage items.
 */
const AQUIFER_HEADER_PATTERN = /^- \*\*(.+?)\*\* \(([A-Za-z0-9_-]+)\)\s*$/;

const AQUIFER_COUNT_PATTERN = /^Found (\d+) resource/;

/** Split `Type: X | Order: Y | Articles: 123 | ...` into a field map. */
function parseAquiferDetailLine(line: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const segment of line.split('|')) {
    const colon = segment.indexOf(':');
    if (colon === -1) continue;
    fields.set(segment.slice(0, colon).trim(), segment.slice(colon + 1).trim());
  }
  return fields;
}

/**
 * Publisher inferred from the resource_code prefix. Heuristic: aquifer's
 * listing has no organization field, but its code vocabulary is stable and
 * prefix-scoped. Unknown prefixes yield undefined rather than a guess.
 */
const AQUIFER_ORG_PREFIXES: [string, string][] = [
  ['Aquifer', 'Aquifer'],
  ['Biblica', 'Biblica'],
  ['SIL', 'SIL'],
  ['UBS', 'UBS'],
  ['UW', 'unfoldingWord'],
  ['unfoldingWord', 'unfoldingWord'],
  ['FIA', 'FIA'],
  ['BDB', 'BDB'],
];

export function deriveAquiferOrganization(resourceCode: string): string | undefined {
  const match = AQUIFER_ORG_PREFIXES.find(([prefix]) => resourceCode.startsWith(prefix));
  return match?.[1];
}

/**
 * IETF-style code (endpoint vocabulary, e.g. "en") → ISO 639-3 as aquifer
 * expects (e.g. "eng"). Covers the languages aquifer actually serves today;
 * 3-letter input passes through, unknown codes pass through unchanged (the
 * server then simply returns no matches).
 */
const AQUIFER_LANGUAGE_MAP: Record<string, string> = {
  en: 'eng',
  es: 'spa',
  fr: 'fra',
  pt: 'por',
  hi: 'hin',
  ar: 'arb',
  ru: 'rus',
  id: 'ind',
  sw: 'swh',
  ne: 'nep',
  ja: 'jpn',
  nl: 'nld',
  gu: 'guj',
  ha: 'hau',
  ig: 'ibo',
  bi: 'bis',
  vi: 'vie',
  fa: 'fas',
  ms: 'zlm',
  zh: 'zhs',
  'zh-hans': 'zhs',
  'zh-hant': 'zht',
  // Region conventions for Chinese where the script is implied by region.
  'zh-cn': 'zhs',
  'zh-sg': 'zhs',
  'zh-tw': 'zht',
  'zh-hk': 'zht',
  'zh-mo': 'zht',
};

export function toAquiferLanguage(language: string): string {
  const key = language.toLowerCase();
  // IETF fallback truncation (BCP 47 §4.3-style): try the full tag, then
  // progressively drop trailing subtags (zh-hant-tw → zh-hant → zh) so
  // script-specific mappings win before the bare primary. Aquifer only
  // speaks ISO 639-3, so sending an unmapped regional tag verbatim would
  // return a misleading "ok, zero resources".
  const parts = key.split('-');
  for (let end = parts.length; end >= 1; end--) {
    const candidate = parts.slice(0, end).join('-');
    // Lookup in a module-const map with a validated language code; worst
    // case is undefined.
    // eslint-disable-next-line security/detect-object-injection
    const mapped = AQUIFER_LANGUAGE_MAP[candidate];
    if (mapped) return mapped;
  }
  // Unknown primary subtag: pass it through unchanged (the server then
  // simply returns no matches, reported as ok/empty).
  return parts[0] ?? key;
}

function parseAquiferEntry(headerLine: string, detailLine: string): ResourceItem | undefined {
  const header = AQUIFER_HEADER_PATTERN.exec(headerLine);
  const label = header?.[1];
  const resourceCode = header?.[2];
  if (!label || !resourceCode) return undefined;
  const fields = parseAquiferDetailLine(detailLine);
  const rawType = fields.get('Type');
  if (!rawType) return undefined;
  const item: ResourceItem = {
    name: resourceCode,
    subject: normalizeSubject(rawType, AQUIFER_TYPE_MAP),
    serverId: '', // stamped by the caller
    label,
  };
  const articles = fields.get('Articles');
  if (articles && /^\d+$/.test(articles)) item.articleCount = Number(articles);
  const organization = deriveAquiferOrganization(resourceCode);
  if (organization) item.organization = organization;
  return item;
}

/**
 * Cross-check parsed entries against the "Found N resource(s)" header so a
 * format drift fails loudly instead of silently dropping resources.
 */
function assertAquiferCount(text: string, parsedCount: number): void {
  const countMatch = AQUIFER_COUNT_PATTERN.exec(text);
  const declared = countMatch ? Number(countMatch[1]) : undefined;
  if (declared !== undefined && declared !== parsedCount) {
    throw new Error(
      `aquifer listing declared ${declared} resources but ${parsedCount} parsed — format may have changed`
    );
  }
  if (declared === undefined && parsedCount === 0 && text.trim().length > 0) {
    throw new Error('aquifer listing format not recognized');
  }
}

export function parseAquiferListing(text: string, serverId: string): ResourceItem[] {
  const lines = text.split(/\r?\n/);
  const items: ResourceItem[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const entry = parseAquiferEntry(lines[i] ?? '', lines[i + 1] ?? '');
    if (entry) items.push({ ...entry, serverId });
  }
  assertAquiferCount(text, items.length);
  return items;
}

// ─── Capability detection ─────────────────────────────────────────────────────

export interface ResourceListingAdapter {
  /** Which adapter matched (for logs). */
  id: 'translation-helps' | 'aquifer';
  toolName: string;
  buildArgs(language: string): Record<string, unknown>;
  parse(text: string, serverId: string): ResourceItem[];
}

const TRANSLATION_HELPS_ADAPTER: ResourceListingAdapter = {
  id: 'translation-helps',
  toolName: 'list_resources_for_language',
  buildArgs: (language) => ({ language }),
  parse: parseTranslationHelpsListing,
};

const AQUIFER_ADAPTER: ResourceListingAdapter = {
  id: 'aquifer',
  toolName: 'list',
  buildArgs: (language) => ({ language: toAquiferLanguage(language) }),
  parse: parseAquiferListing,
};

/**
 * Pick the adapter for a server from its discovered tool manifest. The
 * specific tool name is checked before the generic one; a server exposing
 * neither is `unsupported` (e.g. FIA — nav/content tools only).
 */
export function selectListingAdapter(
  tools: MCPToolDefinition[]
): ResourceListingAdapter | undefined {
  const names = new Set(tools.map((t) => t.name));
  if (names.has(TRANSLATION_HELPS_ADAPTER.toolName)) return TRANSLATION_HELPS_ADAPTER;
  if (names.has(AQUIFER_ADAPTER.toolName)) return AQUIFER_ADAPTER;
  return undefined;
}

// ─── Aggregation fan-out ──────────────────────────────────────────────────────

/** Injectable seams for unit tests; production callers use the defaults. */
export interface ListOrgResourcesDeps {
  discoverAllTools: typeof discoverAllTools;
  callMCPTool: typeof callMCPTool;
}

export interface ListOrgResourcesResult {
  resources: ResourcesBySubject;
  servers: ResourceServerReport[];
}

interface ServerListingOutcome {
  report: ResourceServerReport;
  items: ResourceItem[];
}

/** List one server's resources, degrading every failure to a report. */
async function listServerResources(
  server: MCPServerConfig,
  manifest: MCPServerManifest | undefined,
  language: string,
  logger: RequestLogger,
  deps: ListOrgResourcesDeps
): Promise<ServerListingOutcome> {
  const base = { serverId: server.id, serverName: server.name };
  if (!manifest || manifest.error) {
    // Discovery already logged the failure with per-server context;
    // degrade to an error report so other servers still populate.
    return {
      report: {
        ...base,
        status: 'error',
        error: manifest?.error ?? 'Tool discovery returned no manifest for this server',
      },
      items: [],
    };
  }
  const adapter = selectListingAdapter(manifest.tools);
  if (!adapter) {
    return { report: { ...base, status: 'unsupported' }, items: [] };
  }
  try {
    const call = await deps.callMCPTool(
      server,
      adapter.toolName,
      adapter.buildArgs(language),
      logger
    );
    const text = typeof call.result === 'string' ? call.result : JSON.stringify(call.result);
    const items = adapter.parse(text, server.id);
    return { report: { ...base, status: 'ok' }, items };
  } catch (error) {
    logger.error('resource_listing_failed', error, {
      server_id: server.id,
      adapter: adapter.id,
      language,
    });
    // Degrade to a per-server error report — the aggregate response
    // stays useful and the failure is visible in both logs and payload.
    return {
      report: {
        ...base,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      },
      items: [],
    };
  }
}

function groupBySubject(outcomes: ServerListingOutcome[]): Map<string, ResourceItem[]> {
  const grouped = new Map<string, ResourceItem[]>();
  for (const { items } of outcomes) {
    for (const item of items) {
      const bucket = grouped.get(item.subject);
      if (bucket) {
        bucket.push(item);
      } else {
        grouped.set(item.subject, [item]);
      }
    }
  }
  return grouped;
}

/**
 * Aggregate resource listings across an org's enabled MCP servers.
 *
 * Servers are processed in ascending `priority` order (the same comparator
 * the chat path uses), so within each subject the default item order is
 * server-priority order with server-default order inside each server.
 */
export async function listOrgResources(
  servers: MCPServerConfig[],
  language: string,
  logger: RequestLogger,
  deps: ListOrgResourcesDeps = { discoverAllTools, callMCPTool }
): Promise<ListOrgResourcesResult> {
  const startTime = Date.now();
  const enabled = servers.filter((s) => s.enabled).sort((a, b) => a.priority - b.priority);
  const manifests = await deps.discoverAllTools(enabled, logger);

  const perServer = await Promise.all(
    enabled.map((server) =>
      listServerResources(
        server,
        manifests.find((m) => m.serverId === server.id),
        language,
        logger,
        deps
      )
    )
  );

  const grouped = groupBySubject(perServer);
  const reports = perServer.map((p) => p.report);
  logger.log('resource_listing_complete', {
    language,
    server_count: enabled.length,
    ok_count: reports.filter((r) => r.status === 'ok').length,
    unsupported_count: reports.filter((r) => r.status === 'unsupported').length,
    error_count: reports.filter((r) => r.status === 'error').length,
    subject_count: grouped.size,
    item_count: [...grouped.values()].reduce((sum, v) => sum + v.length, 0),
    known_subject_misses: [...grouped.keys()].filter(
      (k) => !(KNOWN_SUBJECTS as readonly string[]).includes(k)
    ),
    duration_ms: Date.now() - startTime,
  });

  return { resources: Object.fromEntries(grouped), servers: reports };
}
