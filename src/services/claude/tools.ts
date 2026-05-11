/**
 * Claude tool definitions
 *
 * Claude has access to two meta-tools:
 * - execute_code: Run JS in QuickJS sandbox with MCP tool access
 * - get_tool_definitions: Get full schemas for MCP tools
 *
 * MCP tools are NOT exposed directly to Claude. Instead:
 * - System prompt shows a compact catalog (name + summary)
 * - Claude calls get_tool_definitions to learn full schemas
 * - Claude uses execute_code to call MCP tools
 */

import Anthropic from '@anthropic-ai/sdk';
import { JSONSchema, ToolCatalog } from '../mcp/types.js';

/**
 * Build execute_code tool definition
 */
export function buildExecuteCodeTool(): Anthropic.Tool {
  return {
    name: 'execute_code',
    description: `Execute JavaScript code in a sandboxed QuickJS environment.

SYNTAX: ES2020 JavaScript (not TypeScript). Your code runs in an async context, so you can use await directly.

PATTERN:
const result = await tool_name({ param: "value" });
__result__ = result;

AVAILABLE: console.log/info/warn/error, JSON, all MCP tool functions
NOT AVAILABLE: fetch, require, import, process, eval, Function constructor

RESOURCE LIMITS:
- Maximum 10 MCP tool calls per execute_code invocation (hard limit - execution fails if exceeded)
- 30 second timeout per execution
- If you need more data, fetch a batch, inform the user what you got, and offer to continue

The code MUST set __result__ to return a value.`,
    input_schema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'ES2020 JavaScript code. Use await for MCP tool calls. Must set __result__ to return a value.',
        },
      },
      required: ['code'],
    },
  };
}

/**
 * Build get_tool_definitions tool definition
 */
export function buildGetToolDefinitionsTool(): Anthropic.Tool {
  return {
    name: 'get_tool_definitions',
    description:
      'Get the full JSON Schema definitions for one or more MCP tools. Use this to understand the exact parameters a tool accepts before calling it.',
    input_schema: {
      type: 'object',
      properties: {
        tool_names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Names of the tools to get definitions for',
        },
      },
      required: ['tool_names'],
    },
  };
}

/**
 * Build read_memory tool definition
 */
export function buildReadMemoryTool(): Anthropic.Tool {
  return {
    name: 'read_memory',
    description:
      'Read from persistent user memory. Call with no arguments to get the full memory document, or pass specific section names to read only those sections.',
    input_schema: {
      type: 'object',
      properties: {
        sections: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of section names to read. Omit to read full memory.',
        },
      },
      required: [],
    },
  };
}

/**
 * Build update_memory tool definition
 */
export function buildUpdateMemoryTool(): Anthropic.Tool {
  return {
    name: 'update_memory',
    description: `Create, update, or delete sections in the user's persistent memory. Pass an object where keys are section names and values are either markdown content (to create/update) or null (to delete). Multiple sections can be updated in a single call. The sections object must contain at least one entry. Use pin/unpin arrays to control which entries are protected from automatic eviction. Pass \`sections\` as an object directly in the tool input; do not JSON.stringify it.`,
    input_schema: {
      type: 'object',
      properties: {
        sections: {
          type: 'object',
          additionalProperties: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
          },
          description:
            'Object of section updates. String values create/replace sections. Null values delete sections.',
        },
        pin: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of section names to pin. Pinned sections are never automatically evicted.',
        },
        unpin: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of section names to unpin. Unpinned sections may be evicted when memory is full.',
        },
      },
      required: ['sections'],
    },
  };
}

/**
 * Build request_audio tool definition
 */
export function buildRequestAudioTool(): Anthropic.Tool {
  return {
    name: 'request_audio',
    description:
      'Request that the response be delivered as audio. Use when the user asks to hear or listen to content.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  };
}

/**
 * Build generate_scripture_pdf tool definition.
 *
 * Macro-tool that orchestrates the whole ptxprint pipeline. Prefer this for
 * standard scripture PDF requests; drop to the raw catalog tools
 * (submit_typeset / get_job_status / cancel_job) only when the user wants
 * something the macro doesn't support — autofill mode, multi-book payloads,
 * custom configs, illustration figures, etc. The macro returns
 * `{ status: "succeeded", pdf_url, ... }` on the happy path; an attachment
 * is auto-attached to the chat response so the URL renders natively, not as
 * a raw link.
 */
export function buildGenerateScripturePdfTool(): Anthropic.Tool {
  return {
    name: 'generate_scripture_pdf',
    description:
      'Generate a print-ready PDF of a single book from the Berean Standard Bible (BSB), using the canon-validated default layout. Returns a PDF attachment that renders inline in chat clients. Use this for the standard "give me a PDF of John from BSB"-style request. ' +
      'For custom layouts, paper sizes, fonts, or anything else off the happy path: do NOT request multiple parameters here — instead, query the `docs` tool from ptxprint-mcp (e.g. `docs("config_files for letter two-column")`) to retrieve canon guidance, then assemble a payload yourself with `prepare_usfm_source` + the raw `submit_typeset` MCP tool. The canon is the source of truth for layout recipes; this macro only covers the default.',
    input_schema: {
      type: 'object',
      properties: {
        translation: {
          type: 'string',
          enum: ['bsb'],
          description:
            'Translation id. v1 supports bsb (Berean Standard Bible). Door43 unfoldingWord translations are tracked as v1.1 — they need additional stylesheet support for UFW-specific markers (\\s5 plus alignment markers in en_ult/en_ust).',
        },
        book: {
          type: 'string',
          description:
            '3-letter Paratext book code, e.g. "JHN" for John, "GEN" for Genesis. Single book only in v1.',
        },
        preset: {
          type: 'string',
          enum: ['bsb-empirical'],
          description:
            'Layout preset. Defaults to bsb-empirical (canon-validated single-column reference layout) if omitted. v1 ships exactly this one preset; for other layouts use the docs+raw-tools loop described in the tool summary.',
        },
      },
      required: ['translation', 'book'],
    },
  };
}

/**
 * Build prepare_usfm_source tool definition.
 *
 * Helper that exposes our USFM resolver so Claude can hand-build payloads
 * for the raw `submit_typeset` MCP tool. Required because submit_typeset
 * needs sha256 on every source entry, which Claude cannot compute in
 * conversation without falling back to execute_code.
 */
export function buildPrepareUsfmSourceTool(): Anthropic.Tool {
  return {
    name: 'prepare_usfm_source',
    description:
      "Resolve a (translation, book) pair to a `sources[]` entry suitable for ptxprint-mcp's `submit_typeset` payload. Returns { book, filename, url, sha256 } — drop straight into the sources array. " +
      'Use this when assembling a custom payload for raw `submit_typeset` — typical custom flow is: (1) call `docs` on ptxprint-mcp for layout guidance, (2) call this tool to resolve USFM sources, (3) use execute_code to splice the docs recipe + this output into a valid payload, (4) call `submit_typeset` and poll `get_job_status` until done.',
    input_schema: {
      type: 'object',
      properties: {
        translation: {
          type: 'string',
          enum: ['bsb'],
          description: 'Translation id (same set as generate_scripture_pdf — v1 ships bsb only).',
        },
        book: {
          type: 'string',
          description: '3-letter Paratext book code, e.g. "JHN".',
        },
      },
      required: ['translation', 'book'],
    },
  };
}

/**
 * Build read_r2_object tool definition.
 *
 * Lets Claude retrieve a previously-archived voice submission (or other
 * org-scoped R2 object) and obtain a worker-relative URL the client can
 * play. Required for spoken-mode replay flows where a participant asks
 * the bot to play back another participant's stored story.
 *
 * Scoped: the orchestrator enforces that the `r2_key` belongs to the
 * current org (prefix `voice-submissions/{org}/...`) before returning a
 * URL.
 */
export function buildReadR2ObjectTool(): Anthropic.Tool {
  return {
    name: 'read_r2_object',
    description:
      'Resolve a stored R2 object key (e.g. an archived voice submission saved during spoken-mode story collection) to a worker-relative URL that the client can play. Scoped to the current org: the r2_key MUST start with `voice-submissions/<org>/`. Use when you need to inspect or refer back to a previously-stored audio object — but to actually deliver the audio to the user as a response attachment, call `attach_audio` instead.',
    input_schema: {
      type: 'object',
      properties: {
        r2_key: {
          type: 'string',
          description:
            'The R2 object key. Must start with `voice-submissions/<org>/` where <org> is the current org. Other prefixes (e.g. `audio/`) are rejected.',
        },
      },
      required: ['r2_key'],
    },
  };
}

/**
 * Build attach_audio tool definition.
 *
 * Lets Claude attach a stored audio object to the response so the client
 * renders it as audio playback alongside (or instead of) freshly-synthesized
 * TTS. The typical case is spoken-mode replaying a participant's original
 * voice story when asked "play me Amara's story."
 *
 * Scoped the same way as `read_r2_object`. The tool pushes an
 * AudioAttachment onto the request's attachmentsContext; the worker
 * surfaces it on ChatResponse.attachments.
 */
export function buildAttachAudioTool(): Anthropic.Tool {
  return {
    name: 'attach_audio',
    description:
      'Attach a stored audio object to the response so the client plays it back to the user. Use when the user asks to hear a previously-recorded voice submission (e.g. "play me Amara’s story"). Coexists with TTS: you may say a short text intro ("Here is Amara’s story") and call this tool to attach the actual recording. Scoped to the current org: the r2_key MUST start with `voice-submissions/<org>/`. Other prefixes (e.g. `audio/` for TTS output) are rejected.',
    input_schema: {
      type: 'object',
      properties: {
        r2_key: {
          type: 'string',
          description:
            'The R2 object key of the audio to attach. Must start with `voice-submissions/<org>/` where <org> is the current org.',
        },
      },
      required: ['r2_key'],
    },
  };
}

/**
 * Build list_modes tool definition
 */
export function buildListModesTool(): Anthropic.Tool {
  return {
    name: 'list_modes',
    description:
      'List all available assistant modes and which mode is currently active. Modes change how the assistant behaves (e.g., different methodology, instructions, or persona).',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  };
}

/**
 * Build switch_mode tool definition
 */
export function buildSwitchModeTool(): Anthropic.Tool {
  return {
    name: 'switch_mode',
    description:
      'Switch the assistant to a different mode. The change takes effect on the next message. Pass the mode name to switch to, or null to clear the current mode and return to the default.',
    input_schema: {
      type: 'object',
      properties: {
        mode: {
          oneOf: [{ type: 'string' }, { type: 'null' }],
          description: 'The name of the mode to switch to, or null to clear the current mode.',
        },
      },
      required: ['mode'],
    },
  };
}

/**
 * Build all tool definitions for Claude
 *
 * NOTE: We intentionally do NOT expose MCP tools as direct Claude tools.
 * This follows the lasker-api pattern where:
 * - System prompt shows a compact catalog of MCP tools (name + summary)
 * - Claude uses get_tool_definitions to learn full schemas
 * - Claude calls MCP tools via execute_code
 *
 * Benefits:
 * - Dramatically reduces tokens when tool count grows (50+ tools)
 * - Forces Claude to be intentional about which tools to use
 * - Full schemas are loaded on-demand, not upfront
 */
export function buildAllTools(
  _catalog: ToolCatalog,
  opts?: { hasModes?: boolean }
): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [
    buildExecuteCodeTool(),
    buildGetToolDefinitionsTool(),
    buildReadMemoryTool(),
    buildUpdateMemoryTool(),
    buildRequestAudioTool(), // Always available — TTS is a platform capability, not org-gated
    buildGenerateScripturePdfTool(), // Always available — short-circuits to error if ptxprint-mcp not registered for the org
    buildPrepareUsfmSourceTool(),
    buildReadR2ObjectTool(), // Always available — scope-guarded to the request's org
    buildAttachAudioTool(), // Always available — scope-guarded to the request's org
  ];

  if (opts?.hasModes) {
    tools.push(buildListModesTool(), buildSwitchModeTool());
  }

  return tools;
}

/**
 * Check if a tool is a built-in tool (not an MCP tool)
 */
/**
 * Names of every built-in (non-MCP) tool. Used to distinguish worker-side
 * tool dispatch from MCP server forwarding. Kept as a frozen Set so new
 * built-ins can be added without growing the cyclomatic complexity of the
 * predicate.
 */
const BUILT_IN_TOOL_NAMES: ReadonlySet<string> = new Set([
  'execute_code',
  'get_tool_definitions',
  'read_memory',
  'update_memory',
  'request_audio',
  'list_modes',
  'switch_mode',
  'generate_scripture_pdf',
  'prepare_usfm_source',
  'read_r2_object',
  'attach_audio',
]);

export function isBuiltInTool(toolName: string): boolean {
  return BUILT_IN_TOOL_NAMES.has(toolName);
}

/** Maximum number of sections in a single read_memory request */
const MAX_READ_SECTIONS = 50;

/** Maximum number of sections in a single update_memory request */
const MAX_UPDATE_SECTIONS = 50;

/**
 * Type guard for read_memory input.
 * sections is optional; if present, must be a non-empty string array.
 */
export function isReadMemoryInput(input: unknown): input is { sections?: string[] } {
  if (typeof input !== 'object' || input === null) return false;
  if (!('sections' in input)) return true; // no sections = read full
  const sections = (input as { sections: unknown }).sections;
  if (!Array.isArray(sections)) return false;
  if (sections.length === 0) return false; // empty array not allowed — omit parameter for full reads
  return (
    sections.length <= MAX_READ_SECTIONS &&
    sections.every((s) => typeof s === 'string' && s.length > 0)
  );
}

/** Validate an optional string array field on input (for pin/unpin) */
function isValidOptionalStringArray(input: object, field: string): boolean {
  if (!(field in input)) return true;
  const value = (input as Record<string, unknown>)[field]; // eslint-disable-line security/detect-object-injection -- field is a hardcoded string
  return Array.isArray(value) && value.every((s) => typeof s === 'string' && s.length > 0);
}

/** Validate that sections is a valid Record<string, string|null> with constraints */
function isValidSectionsObject(input: object): boolean {
  const sections = (input as { sections: unknown }).sections;
  if (typeof sections !== 'object' || sections === null || Array.isArray(sections)) return false;
  const entries = Object.entries(sections as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_UPDATE_SECTIONS) return false;
  return entries.every(([key, val]) => key.length > 0 && (typeof val === 'string' || val === null));
}

/**
 * Type guard for update_memory input.
 * sections is required, keys are section names, values are string|null.
 * pin and unpin are optional string arrays.
 */
export function isUpdateMemoryInput(
  input: unknown
): input is { sections: Record<string, string | null>; pin?: string[]; unpin?: string[] } {
  if (typeof input !== 'object' || input === null) return false;
  if (!('sections' in input)) return false;
  if (!isValidSectionsObject(input)) return false;
  return isValidOptionalStringArray(input, 'pin') && isValidOptionalStringArray(input, 'unpin');
}

/**
 * Type guard for switch_mode input.
 * mode is required and must be a string or null.
 */
export function isSwitchModeInput(input: unknown): input is { mode: string | null } {
  if (typeof input !== 'object' || input === null) return false;
  if (!('mode' in input)) return false;
  const mode = (input as { mode: unknown }).mode;
  return mode === null || (typeof mode === 'string' && mode.length > 0);
}

/** Maximum length for an R2 key on read_r2_object / attach_audio. Generous cap — real keys are ~120 chars. */
const MAX_R2_KEY_LENGTH = 512;

/**
 * Type guard for read_r2_object / attach_audio input (same shape).
 * r2_key is required, non-empty, length-capped.
 */
export function isR2KeyInput(input: unknown): input is { r2_key: string } {
  if (typeof input !== 'object' || input === null) return false;
  if (!('r2_key' in input)) return false;
  const key = (input as { r2_key: unknown }).r2_key;
  return typeof key === 'string' && key.length > 0 && key.length <= MAX_R2_KEY_LENGTH;
}

/**
 * Get tool definitions from catalog
 */
export function getToolDefinitions(
  catalog: ToolCatalog,
  toolNames: string[]
): Record<string, JSONSchema> {
  const definitions: Record<string, JSONSchema> = {};

  for (const name of toolNames) {
    const tool = catalog.tools.find((t) => t.name === name);
    if (tool) {
      // eslint-disable-next-line security/detect-object-injection -- name is from controlled toolNames array
      definitions[name] = tool.inputSchema;
    }
  }

  return definitions;
}
