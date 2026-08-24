/**
 * Aggregated resource listing (worker#257 item 1).
 *
 * Parser tests run against fixtures captured verbatim from the live
 * servers: translation-helps `list_resources_for_language(en)` and aquifer
 * `list(eng)` (production, 2026-07-30), and translation-helps v2
 * `list_resources(en)` (staging, 2026-08-18). If a server changes its format,
 * refresh the fixture and these tests show the drift.
 */
import { describe, expect, it, vi } from 'vitest';
// Vite ?raw imports — the workers test pool has no filesystem access.
// @ts-expect-error -- ?raw module resolution is handled by Vite, not tsc
import AQUIFER_FIXTURE from '../fixtures/aquifer-list-eng.md?raw';
// @ts-expect-error -- ?raw module resolution is handled by Vite, not tsc
import TH_FIXTURE from '../fixtures/translation-helps-list-en.json?raw';
// @ts-expect-error -- ?raw module resolution is handled by Vite, not tsc
import TH_V2_FIXTURE from '../fixtures/translation-helps-v2-list-en.txt?raw';
// @ts-expect-error -- ?raw module resolution is handled by Vite, not tsc
import OBS_5M_EN_FIXTURE from '../fixtures/obs-5m-list-en.txt?raw';
// @ts-expect-error -- ?raw module resolution is handled by Vite, not tsc
import OBS_5M_ID_FIXTURE from '../fixtures/obs-5m-list-id.txt?raw';
import {
  deriveAquiferOrganization,
  listOrgResources,
  parseAquiferListing,
  parseObs5mListing,
  parseTranslationHelpsListing,
  parseTranslationHelpsV2Listing,
  selectListingAdapter,
  slugifySubject,
  toAquiferLanguage,
  type ListOrgResourcesDeps,
} from '../../src/services/mcp/resource-listing.js';
import type { MCPServerConfig, MCPToolDefinition } from '../../src/services/mcp/types.js';
import { KNOWN_SUBJECTS } from '../../src/types/resources.js';
import { createRequestLogger } from '../../src/utils/logger.js';

const logger = createRequestLogger('test-request-id');

function tool(name: string): MCPToolDefinition {
  return { name, description: `${name} tool`, inputSchema: { type: 'object' } };
}

function server(id: string, overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    id,
    name: `Server ${id}`,
    url: `https://${id}.example.com/mcp`,
    enabled: true,
    priority: 1,
    ...overrides,
  };
}

// ─── translation-helps parser ─────────────────────────────────────────────────

describe('parseTranslationHelpsListing', () => {
  it('parses the live fixture into normalized items', () => {
    const items = parseTranslationHelpsListing(TH_FIXTURE, 'translation-helps');
    expect(items).toHaveLength(9);
    expect(items.every((i) => i.serverId === 'translation-helps')).toBe(true);

    const ult = items.find((i) => i.name === 'en_ult');
    expect(ult).toMatchObject({
      subject: 'aligned-bible',
      organization: 'unfoldingWord',
      version: 'v89',
    });

    const tn = items.find((i) => i.name === 'en_tn');
    expect(tn?.subject).toBe('translation-notes');
  });

  it('normalizes all seven live subjects onto known canonical slugs', () => {
    const items = parseTranslationHelpsListing(TH_FIXTURE, 's');
    const subjects = new Set(items.map((i) => i.subject));
    expect([...subjects].sort()).toEqual([
      'aligned-bible',
      'bible',
      'translation-academy',
      'translation-notes',
      'translation-questions',
      'translation-words',
      'translation-words-links',
    ]);
    for (const subject of subjects) {
      expect(KNOWN_SUBJECTS).toContain(subject);
    }
  });

  it('slugifies unknown subject vocabulary instead of dropping it', () => {
    const payload = JSON.stringify({
      resourcesBySubject: {
        'Brand New Category': [{ name: 'x', subject: 'Brand New Category' }],
      },
    });
    const items = parseTranslationHelpsListing(payload, 's');
    expect(items[0].subject).toBe('brand-new-category');
  });
});

describe('parseTranslationHelpsListing errors', () => {
  it('throws on non-JSON payloads', () => {
    expect(() => parseTranslationHelpsListing('Found 9 resources...', 's')).toThrow(
      /not valid JSON/
    );
  });

  it('throws when resourcesBySubject is missing', () => {
    expect(() => parseTranslationHelpsListing('{"subjects":[]}', 's')).toThrow(
      /resourcesBySubject/
    );
  });

  it('throws when an item is missing name/subject', () => {
    const payload = JSON.stringify({ resourcesBySubject: { Bible: [{ organization: 'x' }] } });
    expect(() => parseTranslationHelpsListing(payload, 's')).toThrow(/missing name\/subject/);
  });
});

// ─── aquifer parser ───────────────────────────────────────────────────────────

describe('parseTranslationHelpsV2Listing', () => {
  it('parses the live fixture into normalized items', () => {
    const items = parseTranslationHelpsV2Listing(TH_V2_FIXTURE, 'th-v2');
    expect(items).toHaveLength(11);
    expect(items.every((i) => i.serverId === 'th-v2')).toBe(true);
    // name comes from `abbreviation`, not the subject label.
    expect(items.map((i) => i.name)).toContain('ult');
    expect(items.map((i) => i.name)).toContain('uhb');
  });

  it('maps the seven known v2 subjects onto canonical slugs', () => {
    const items = parseTranslationHelpsV2Listing(TH_V2_FIXTURE, 'th-v2');
    const subjects = new Set(items.map((i) => i.subject));
    for (const known of [
      'aligned-bible',
      'bible',
      'translation-notes',
      'translation-words-links',
      'translation-words',
      'translation-academy',
      'translation-questions',
    ]) {
      expect(subjects).toContain(known);
      expect(KNOWN_SUBJECTS).toContain(known);
    }
  });

  it('slugifies the two unmapped original-language subjects instead of dropping them', () => {
    const items = parseTranslationHelpsV2Listing(TH_V2_FIXTURE, 'th-v2');
    const subjects = items.map((i) => i.subject);
    // v2 ships Greek New Testament / Hebrew Old Testament, which the shared
    // subject map does not cover — they must degrade visibly, not vanish.
    expect(subjects).toContain('greek-new-testament');
    expect(subjects).toContain('hebrew-old-testament');
    expect(KNOWN_SUBJECTS).not.toContain('greek-new-testament');
  });

  it('omits organization and version, which v2 does not send', () => {
    const items = parseTranslationHelpsV2Listing(TH_V2_FIXTURE, 'th-v2');
    expect(items.every((i) => i.organization === undefined)).toBe(true);
    expect(items.every((i) => i.version === undefined)).toBe(true);
  });

  it('ignores the summary block and locates the JSON by its first brace', () => {
    const jsonOnly = TH_V2_FIXTURE.slice(TH_V2_FIXTURE.indexOf('{'));
    expect(parseTranslationHelpsV2Listing(jsonOnly, 'th-v2')).toHaveLength(11);
  });
});

describe('parseTranslationHelpsV2Listing errors', () => {
  it('throws when the declared count does not match parsed items', () => {
    const drifted = TH_V2_FIXTURE.replace('11 resource(s) available', '12 resource(s) available');
    expect(() => parseTranslationHelpsV2Listing(drifted, 'th-v2')).toThrow(/declared 12/);
  });

  it('throws on payloads with no JSON at all', () => {
    expect(() => parseTranslationHelpsV2Listing('0 resource(s) available for zz', 'th-v2')).toThrow(
      /no JSON payload/
    );
  });

  it('throws on malformed JSON', () => {
    expect(() => parseTranslationHelpsV2Listing('summary\n\n{"available":', 'th-v2')).toThrow(
      /not valid JSON/
    );
  });

  it('throws when the available array is missing', () => {
    expect(() => parseTranslationHelpsV2Listing('{"language":"en"}', 'th-v2')).toThrow(
      /missing "available"/
    );
  });

  it('throws when an item is missing abbreviation/subject', () => {
    expect(() =>
      parseTranslationHelpsV2Listing('{"available":[{"type":"scripture"}]}', 'th-v2')
    ).toThrow(/missing abbreviation\/subject/);
  });
});

describe('parseObs5mListing', () => {
  it('parses the live English listing into bible-stories', () => {
    const items = parseObs5mListing(OBS_5M_EN_FIXTURE, 'obs-5m');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      name: 'obs-tf',
      subject: 'bible-stories',
      serverId: 'obs-5m',
      organization: 'door43',
    });
    expect(KNOWN_SUBJECTS).toContain(items[0]?.subject);
  });

  it('maps Indonesian structured + pdf rows', () => {
    const items = parseObs5mListing(OBS_5M_ID_FIXTURE, 'obs-5m');
    expect(items.map((i) => i.name)).toEqual(['obs-tf', 'obs-tf-pdf']);
    expect(items.map((i) => i.subject)).toEqual(['bible-stories', 'media']);
  });

  it('drops unavailable rows', () => {
    const text =
      '{"language":"es","resources":[{"id":"obs-tf","type":"structured","available":false,"source":"none","description":"missing"}]}';
    expect(parseObs5mListing(text, 'obs-5m')).toEqual([]);
  });
});

describe('parseObs5mListing errors', () => {
  it('throws when the payload has no JSON object', () => {
    expect(() => parseObs5mListing('1 resource type(s) for zz', 'obs-5m')).toThrow(
      /no JSON payload/
    );
  });

  it('throws when resources is missing', () => {
    expect(() => parseObs5mListing('{"language":"en"}', 'obs-5m')).toThrow(
      /missing "resources" array/
    );
  });
});

describe('parseAquiferListing', () => {
  it('parses all 35 entries of the live fixture', () => {
    const items = parseAquiferListing(AQUIFER_FIXTURE, 'aquifer');
    expect(items).toHaveLength(35);
    expect(items.every((i) => i.serverId === 'aquifer')).toBe(true);
  });

  it('extracts label, code, subject, organization and article count', () => {
    const items = parseAquiferListing(AQUIFER_FIXTURE, 'aquifer');
    const dict = items.find((i) => i.name === 'AquiferOpenBibleDictionary');
    expect(dict).toMatchObject({
      label: 'Aquifer Open Bible Dictionary',
      subject: 'dictionary',
      organization: 'Aquifer',
      articleCount: 6111,
    });
  });

  it('maps the aquifer display taxonomy onto canonical slugs', () => {
    const items = parseAquiferListing(AQUIFER_FIXTURE, 'aquifer');
    const subjectOf = (name: string) => items.find((i) => i.name === name)?.subject;
    expect(subjectOf('UWTranslationManual')).toBe('translation-academy');
    expect(subjectOf('UWTranslationNotes')).toBe('translation-notes');
    expect(subjectOf('UWTranslationQuestions')).toBe('translation-questions');
    expect(subjectOf('UWTranslationWords')).toBe('translation-words');
    expect(subjectOf('UWOpenBibleStories')).toBe('bible-stories');
    expect(subjectOf('BereanStandardBible')).toBe('bible');
    expect(subjectOf('UBSImages')).toBe('media');
    expect(subjectOf('UBSHebrewDictionary')).toBe('lexicon');
    expect(subjectOf('DictionaryBibleThemes')).toBe('dictionary');
    expect(subjectOf('BiblicaStudyNotes')).toBe('study-notes');
  });

  it('slugifies unmapped display types instead of dropping them', () => {
    const text =
      'Found 1 resource(s):\n\n- **Weird Thing** (WeirdThing)\n  Type: Weird New Thing | Order: canonical | Articles: 3 | Language: eng | Localizations: none | Tools: get\n';
    const items = parseAquiferListing(text, 's');
    expect(items[0].subject).toBe('weird-new-thing');
  });

  it('returns empty for a zero-resource listing', () => {
    expect(parseAquiferListing('Found 0 resource(s):\n', 's')).toEqual([]);
  });

  it('throws when the declared count does not match parsed entries', () => {
    const truncated = AQUIFER_FIXTURE.split('\n').slice(0, 5).join('\n');
    expect(() => parseAquiferListing(truncated, 's')).toThrow(/declared 35 resources but/);
  });

  it('throws on unrecognized non-empty output', () => {
    expect(() => parseAquiferListing('Internal server error', 's')).toThrow(/not recognized/);
  });
});

describe('aquifer helpers', () => {
  it('derives organizations from known resource_code prefixes', () => {
    expect(deriveAquiferOrganization('UWTranslationNotes')).toBe('unfoldingWord');
    expect(deriveAquiferOrganization('unfoldingWordLiteral')).toBe('unfoldingWord');
    expect(deriveAquiferOrganization('BiblicaStudyNotes')).toBe('Biblica');
    expect(deriveAquiferOrganization('SILOpenTranslatorsNotes')).toBe('SIL');
    expect(deriveAquiferOrganization('BereanStandardBible')).toBeUndefined();
  });

  it('translates IETF-style codes to ISO 639-3 and passes unknowns through', () => {
    expect(toAquiferLanguage('en')).toBe('eng');
    expect(toAquiferLanguage('sw')).toBe('swh');
    expect(toAquiferLanguage('zh-Hant')).toBe('zht');
    expect(toAquiferLanguage('eng')).toBe('eng');
    expect(toAquiferLanguage('xx')).toBe('xx');
  });

  it('falls back through the primary subtag for regional tags (PR #343 review)', () => {
    expect(toAquiferLanguage('es-419')).toBe('spa');
    expect(toAquiferLanguage('en-US')).toBe('eng');
    expect(toAquiferLanguage('pt-BR')).toBe('por');
    // Explicit script-specific mappings still win over the primary fallback.
    expect(toAquiferLanguage('zh-hans')).toBe('zhs');
    // Unknown primary subtags still pass through unchanged.
    expect(toAquiferLanguage('xx-yy')).toBe('xx');
  });

  it('truncates subtags progressively so script mappings beat the primary (re-review)', () => {
    // zh-Hant-TW must hit zh-hant (Traditional) before falling to zh (Simplified).
    expect(toAquiferLanguage('zh-Hant-TW')).toBe('zht');
    expect(toAquiferLanguage('zh-Hans-CN')).toBe('zhs');
    // Region conventions where the script is implied by region.
    expect(toAquiferLanguage('zh-TW')).toBe('zht');
    expect(toAquiferLanguage('zh-HK')).toBe('zht');
    expect(toAquiferLanguage('zh-CN')).toBe('zhs');
    // Truncation also works for non-Chinese multi-subtag tags.
    expect(toAquiferLanguage('es-419-x-priv')).toBe('spa');
  });

  it('slugifySubject falls back to "uncategorized" for degenerate input', () => {
    expect(slugifySubject('***')).toBe('uncategorized');
    expect(slugifySubject('Images, Maps, Videos')).toBe('images-maps-videos');
  });
});

// ─── capability detection ─────────────────────────────────────────────────────

describe('selectListingAdapter', () => {
  it('picks translation-helps when its specific tool exists', () => {
    const adapter = selectListingAdapter([tool('list'), tool('list_resources_for_language')]);
    expect(adapter?.id).toBe('translation-helps');
  });

  it('picks translation-helps-v2 for a list_resources tool', () => {
    expect(selectListingAdapter([tool('list_resources'), tool('get_passage')])?.id).toBe(
      'translation-helps-v2'
    );
  });

  it('picks obs-5m when list_resources is paired with fetch_obs_study_manual', () => {
    expect(selectListingAdapter([tool('list_resources'), tool('fetch_obs_study_manual')])?.id).toBe(
      'obs-5m'
    );
  });

  it('prefers v1 over v2 when a server exposes both listing tools', () => {
    // Ordering guard: v1 carries organization/version that v2 drops, so a
    // server offering both must keep the richer payload. This protects the
    // adapter that serves production today.
    const adapter = selectListingAdapter([
      tool('list_resources'),
      tool('list_resources_for_language'),
    ]);
    expect(adapter?.id).toBe('translation-helps');
  });

  it('passes the language tag through untranslated for v2', () => {
    const adapter = selectListingAdapter([tool('list_resources')]);
    expect(adapter?.buildArgs('en-US')).toEqual({ language: 'en-US' });
  });

  it('picks aquifer for a generic list tool', () => {
    expect(selectListingAdapter([tool('list'), tool('search')])?.id).toBe('aquifer');
  });

  it('returns undefined when no listing tool exists (FIA-style server)', () => {
    expect(selectListingAdapter([tool('get_languages'), tool('get_pericope')])).toBeUndefined();
  });

  it('aquifer adapter translates the language argument', () => {
    const adapter = selectListingAdapter([tool('list')]);
    expect(adapter?.buildArgs('en')).toEqual({ language: 'eng' });
  });
});

// ─── aggregation fan-out ──────────────────────────────────────────────────────

function makeDeps(overrides: Partial<ListOrgResourcesDeps> = {}): ListOrgResourcesDeps {
  return {
    discoverAllTools: async (servers) =>
      servers.map((s) => ({
        serverId: s.id,
        serverName: s.name,
        tools:
          s.id === 'translation-helps'
            ? [tool('list_resources_for_language')]
            : s.id === 'aquifer'
              ? [tool('list')]
              : [tool('get_pericope')],
      })),
    callMCPTool: async (srv, toolName) => ({
      result: toolName === 'list' ? AQUIFER_FIXTURE : TH_FIXTURE,
      metadata: undefined,
      responseTimeMs: 5,
    }),
    ...overrides,
  };
}

describe('listOrgResources', () => {
  it('aggregates both library servers and reports FIA as unsupported', async () => {
    const servers = [server('translation-helps'), server('fia'), server('aquifer')];
    const result = await listOrgResources(servers, 'en', logger, makeDeps());

    expect(result.servers).toEqual([
      { serverId: 'translation-helps', serverName: 'Server translation-helps', status: 'ok' },
      { serverId: 'fia', serverName: 'Server fia', status: 'unsupported' },
      { serverId: 'aquifer', serverName: 'Server aquifer', status: 'ok' },
    ]);

    const total = Object.values(result.resources).reduce((n, items) => n + items.length, 0);
    expect(total).toBe(44); // 9 translation-helps + 35 aquifer

    // Shared subject: both servers contribute translation-notes.
    const notes = result.resources['translation-notes'];
    expect(notes.map((i) => i.serverId)).toEqual([
      'translation-helps',
      'aquifer',
      'aquifer',
      'aquifer',
    ]);
  });

  it('orders servers by ascending priority (same comparator as the chat path)', async () => {
    const servers = [
      server('aquifer', { priority: 1 }),
      server('translation-helps', { priority: 2 }),
    ];
    const result = await listOrgResources(servers, 'en', logger, makeDeps());
    expect(result.servers.map((s) => s.serverId)).toEqual(['aquifer', 'translation-helps']);
    // Within a shared subject, the priority-1 server's items come first.
    expect(result.resources['translation-notes'][0].serverId).toBe('aquifer');
  });

  it('skips disabled servers entirely', async () => {
    const servers = [server('translation-helps'), server('aquifer', { enabled: false })];
    const result = await listOrgResources(servers, 'en', logger, makeDeps());
    expect(result.servers.map((s) => s.serverId)).toEqual(['translation-helps']);
  });

  it('returns empty aggregation for an org with no servers', async () => {
    const result = await listOrgResources([], 'en', logger, makeDeps());
    expect(result).toEqual({ resources: {}, servers: [] });
  });
});

describe('listOrgResources unsupported observability', () => {
  it('warns with the discovered tool names when no adapter matches', async () => {
    // Regression guard for #354: this path used to return zero resources with
    // no telemetry at all, making "unrecognized listing tool" look identical to
    // "server has none" and forcing a manual probe session to tell them apart.
    const warn = vi.spyOn(logger, 'warn');
    try {
      const result = await listOrgResources([server('fia')], 'en', logger, makeDeps());
      expect(result.servers[0]?.status).toBe('unsupported');
      expect(warn).toHaveBeenCalledWith(
        'resource_listing_unsupported',
        expect.objectContaining({ server_id: 'fia', tools: ['get_pericope'] })
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn for servers that do have a matching adapter', async () => {
    const warn = vi.spyOn(logger, 'warn');
    try {
      await listOrgResources([server('aquifer')], 'en', logger, makeDeps());
      expect(warn).not.toHaveBeenCalledWith('resource_listing_unsupported', expect.anything());
    } finally {
      warn.mockRestore();
    }
  });
});

describe('listOrgResources degradation', () => {
  it('reports a discovery failure as error without hiding other servers', async () => {
    const deps = makeDeps({
      discoverAllTools: async (servers) =>
        servers.map((s) =>
          s.id === 'aquifer'
            ? { serverId: s.id, serverName: s.name, tools: [], error: 'connection refused' }
            : { serverId: s.id, serverName: s.name, tools: [tool('list_resources_for_language')] }
        ),
    });
    const result = await listOrgResources(
      [server('translation-helps'), server('aquifer')],
      'en',
      logger,
      deps
    );
    expect(result.servers).toEqual([
      { serverId: 'translation-helps', serverName: 'Server translation-helps', status: 'ok' },
      {
        serverId: 'aquifer',
        serverName: 'Server aquifer',
        status: 'error',
        error: 'connection refused',
      },
    ]);
    expect(Object.values(result.resources).flat()).toHaveLength(9);
  });

  it('reports a listing-call failure as error with the message', async () => {
    const deps = makeDeps({
      callMCPTool: async () => {
        throw new Error('HTTP 502 from server');
      },
    });
    const result = await listOrgResources([server('translation-helps')], 'en', logger, deps);
    expect(result.servers[0]).toMatchObject({ status: 'error', error: 'HTTP 502 from server' });
    expect(result.resources).toEqual({});
  });

  it('reports a parse failure as error (format drift stays visible)', async () => {
    const deps = makeDeps({
      callMCPTool: async () => ({
        result: 'Internal server error',
        metadata: undefined,
        responseTimeMs: 5,
      }),
    });
    const result = await listOrgResources([server('aquifer')], 'en', logger, deps);
    expect(result.servers[0].status).toBe('error');
    expect(result.servers[0].error).toMatch(/not recognized/);
  });
});
