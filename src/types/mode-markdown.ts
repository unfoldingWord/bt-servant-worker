/**
 * Mode markdown ↔ slot conversion.
 *
 * Phase 1 of the mode-data migration (issue #200). The admin portal is
 * replacing its legacy six/seven-slot mode editor with a single markdown
 * editor per mode. The worker must:
 *
 * - Synthesize a markdown document from legacy slot maps on GET so the
 *   portal sees a unified shape.
 * - Tolerate either shape on PUT (markdown document OR legacy slot map) and
 *   persist what was sent.
 * - Parse markdown back to slots at chat runtime so the orchestrator's
 *   slot-based system-prompt assembly keeps working for modes that have
 *   already been migrated to the markdown shape.
 *
 * The mapping between slot keys and the H2 labels visible in the markdown
 * is fixed (see `SLOT_LABELS` below) and shared by both directions of the
 * conversion.
 */

import {
  MAX_MODE_DOCUMENT_LENGTH,
  OrgModes,
  PROMPT_OVERRIDE_SLOTS,
  PromptMode,
  PromptOverrides,
  PromptSlot,
} from './prompt-overrides.js';

export { MAX_MODE_DOCUMENT_LENGTH };

// ─── Labels ──────────────────────────────────────────────────────────────────

/** Display label rendered as the H2 heading for each slot. */
export const SLOT_LABELS: Readonly<Record<PromptSlot, string>> = Object.freeze({
  identity: 'Identity',
  methodology: 'Teaching Methodology',
  tool_guidance: 'Tool Guidance',
  instructions: 'Instructions',
  client_instructions: 'Client Instructions',
  memory_instructions: 'Memory Instructions',
  closing: 'Closing',
});

/** Reverse lookup: H2 heading text → slot key. Exact case-sensitive match. */
export const LABEL_TO_SLOT: Readonly<Record<string, PromptSlot>> = Object.freeze(
  Object.fromEntries(
    (PROMPT_OVERRIDE_SLOTS as readonly PromptSlot[]).map((slot) => [SLOT_LABELS[slot], slot])
  ) as Record<string, PromptSlot>
);

// ─── Synthesis (slots → markdown) ────────────────────────────────────────────

/**
 * Synthesize the canonical markdown document for a mode's overrides.
 *
 * Always emits ALL seven H2 sections in `PROMPT_OVERRIDE_SLOTS` order, even
 * when a slot is unset or empty. This gives the portal a consistent editor
 * shape and keeps round-trip identity (parse(synthesize(o)) === o) for any
 * legitimate sparse mode.
 */
export function synthesizeModeDocument(overrides: PromptOverrides): string {
  const lines: string[] = [];
  for (const slot of PROMPT_OVERRIDE_SLOTS) {
    const label = SLOT_LABELS[slot];
    // eslint-disable-next-line security/detect-object-injection -- slot is from constant
    const value = overrides[slot];
    lines.push(`## ${label}`);
    lines.push('');
    if (typeof value === 'string' && value.trim().length > 0) {
      lines.push(value.trim());
      lines.push('');
    }
  }
  return lines.join('\n');
}

// ─── Parsing (markdown → slots) ──────────────────────────────────────────────

/** Match an H2 line whose heading text is exactly one of the known slot labels. */
function isSlotHeading(line: string): PromptSlot | null {
  // Trim trailing whitespace only (preserve any leading space we might want
  // to count as content if the line happens not to be a heading).
  const stripped = line.replace(/\s+$/, '');
  if (!stripped.startsWith('## ')) return null;
  const heading = stripped.slice(3);

  const slot = Object.prototype.hasOwnProperty.call(LABEL_TO_SLOT, heading)
    ? LABEL_TO_SLOT[heading as keyof typeof LABEL_TO_SLOT]
    : null;
  return slot ?? null;
}

/**
 * Parse a synthesized markdown document back into slot overrides.
 *
 * Splits on lines matching `^## <exact-label>$`. Heading lines that don't
 * exactly match a known slot label are treated as content of the preceding
 * section, so markdown headings *inside* a slot body (e.g. user-supplied
 * `## My Notes` inside Identity) survive intact. Empty trimmed bodies are
 * omitted from the result, preserving the sparse-mode runtime semantics.
 *
 * Robust to non-canonical heading order — slots are merged by name, so a
 * document with sections in a different order parses correctly.
 */
export function parseModeDocument(document: string): PromptOverrides {
  if (typeof document !== 'string' || document.length === 0) return {};

  const result: PromptOverrides = {};
  const lines = document.split('\n');
  let currentSlot: PromptSlot | null = null;
  let currentBody: string[] = [];

  const flush = (): void => {
    if (currentSlot === null) return;
    const body = currentBody.join('\n').trim();
    if (body.length > 0) {
      // eslint-disable-next-line security/detect-object-injection -- key from PROMPT_OVERRIDE_SLOTS
      result[currentSlot] = body;
    }
  };

  for (const line of lines) {
    const slot = isSlotHeading(line);
    if (slot !== null) {
      flush();
      currentSlot = slot;
      currentBody = [];
    } else if (currentSlot !== null) {
      currentBody.push(line);
    }
    // Content before the first heading is discarded — there is no slot to
    // attach it to. Synthesized documents never produce such content.
  }
  flush();

  return result;
}

// ─── Runtime adapter ─────────────────────────────────────────────────────────

/**
 * Return a mode's effective slot overrides regardless of storage shape.
 *
 * Single chokepoint for chat-time resolution. Modes stored as `{ overrides }`
 * pass through unchanged; modes stored as `{ document }` are parsed back to
 * slots on demand. A mode with neither (defensive fallback) returns `{}`.
 */
export function getEffectiveOverrides(mode: PromptMode): PromptOverrides {
  if (mode.overrides !== undefined) return mode.overrides;
  if (typeof mode.document === 'string') return parseModeDocument(mode.document);
  return {};
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate a mode markdown document field.
 * Returns an error message if invalid, `null` if valid.
 */
export function validateModeDocument(value: unknown): string | null {
  if (typeof value !== 'string') return 'Mode document must be a string';
  if (value.length > MAX_MODE_DOCUMENT_LENGTH) {
    return `Mode document exceeds maximum length of ${MAX_MODE_DOCUMENT_LENGTH} characters (got ${value.length})`;
  }
  return null;
}

// ─── Mode resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the effective mode for a request given a (possibly stale) selection.
 *
 * `effectiveModeName` is `undefined` whenever the requested mode is missing or
 * unpublished, so downstream tools (`list_modes`) never surface a draft as
 * "active." `modeOverrides` is the mode's overrides when applicable, otherwise
 * empty. `reason` distinguishes missing vs unpublished for log correlation.
 *
 * Admin-origin requests (identified server-side via `isAdminClient(client_id)`)
 * pass `options.includeUnpublished = true` so authors can test drafts from the
 * portal's test chat pane. For those requests a matched draft returns
 * `reason: 'ok'` — end-user requests keep the default filter.
 *
 * The function lives in this module (alongside `getEffectiveOverrides`)
 * because Phase 1 of #200 means modes may be stored in either the legacy
 * slot-map shape or the new markdown-document shape. `getEffectiveOverrides`
 * absorbs that difference so callers always see slots.
 */
/**
 * Reason a matched mode may not be applied for this caller/context, or null
 * when it is usable. `includeUnpublished` doubles as the admin/preview signal:
 * admins bypass both the publish gate and the group gate (so the portal test
 * chat can preview group-only drafts).
 */
function modeAccessBlockReason(
  mode: PromptMode,
  options?: { includeUnpublished?: boolean; isGroupChat?: boolean }
): 'unpublished' | 'requires-group' | null {
  const isAdmin = options?.includeUnpublished === true;
  if (mode.published !== true && !isAdmin) return 'unpublished';
  if (mode.requires_group === true && options?.isGroupChat !== true && !isAdmin) {
    return 'requires-group';
  }
  return null;
}

export function resolveEffectiveMode(
  orgModes: OrgModes,
  requestedModeName: string | undefined,
  options?: { includeUnpublished?: boolean; isGroupChat?: boolean }
): {
  effectiveModeName: string | undefined;
  modeOverrides: PromptOverrides;
  reason: 'ok' | 'none-requested' | 'missing' | 'unpublished' | 'requires-group';
} {
  if (!requestedModeName) {
    return { effectiveModeName: undefined, modeOverrides: {}, reason: 'none-requested' };
  }
  const mode = orgModes.modes.find((m) => m.name === requestedModeName);
  if (!mode) {
    return { effectiveModeName: undefined, modeOverrides: {}, reason: 'missing' };
  }
  const blockReason = modeAccessBlockReason(mode, options);
  if (blockReason) {
    return { effectiveModeName: undefined, modeOverrides: {}, reason: blockReason };
  }
  return {
    effectiveModeName: requestedModeName,
    modeOverrides: getEffectiveOverrides(mode),
    reason: 'ok',
  };
}
