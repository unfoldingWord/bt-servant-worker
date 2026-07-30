/**
 * Aggregated resource listing (worker#257 item 1).
 *
 * Parser tests run against fixtures captured verbatim from the live
 * production servers (2026-07-30): translation-helps
 * `list_resources_for_language(en)` and aquifer `list(eng)`. If a server
 * changes its format, refresh the fixture and these tests show the drift.
 */
import { describe, expect, it } from 'vitest';
// Vite ?raw imports — the workers test pool has no filesystem access.
// @ts-expect-error -- ?raw module resolution is handled by Vite, not tsc
import AQUIFER_FIXTURE from '../fixtures/aquifer-list-eng.md?raw';
// @ts-expect-error -- ?raw module resolution is handled by Vite, not tsc
import TH_FIXTURE from '../fixtures/translation-helps-list-en.json?raw';
import {
  deriveAquiferOrganization,
  listOrgResources,
  parseAquiferListing,
  parseTranslationHelpsListing,
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
