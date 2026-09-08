/**
 * Per-mode resource-priority directive (issue #366).
 *
 * The admin portal (#277) writes a ranking into a mode document's
 * `## Tool Guidance` section as a delimited, HTML-comment-fenced block:
 *
 *   <!-- bt:resource-priorities -->
 *   <!-- order: ["translation-helps:ult","translation-helps:ust"] -->
 *   ### Resource priorities
 *   When answering from resources, strongly prefer the sources below ...
 *   1. Literal Text — unfoldingWord (Bible)
 *   2. Simplified Text — unfoldingWord (Bible)
 *   ...
 *   <!-- /bt:resource-priorities -->
 *
 * `parseModeDocument` keeps that block verbatim as body text of the
 * `tool_guidance` slot, so the model already *reads* the prose — but it did
 * nothing, because nothing connected "prefer Literal Text" to a concrete tool
 * lever, and the raw HTML comments leaked into the prompt unstripped.
 *
 * This module closes both gaps at prompt-assembly time, without mutating stored
 * documents and without any new wire field (the machine-readable half is the
 * `<!-- order -->` comment the portal already emits):
 *
 *  1. It strips the HTML-comment marker lines so they never reach the model.
 *  2. When the order parses, it appends an actionable directive that names the
 *     ranked resource identifiers (the `name` half of each `serverId:name`
 *     id — which, for scripture on translation-helps, is exactly the value
 *     `fetch_scripture`'s `resource` parameter expects, e.g. `ult`/`ust`) and
 *     instructs the model to pass them through the tool's own resource selector
 *     in priority order.
 *
 * HONEST LIMITATION: this is strong prompt-bias, not server-side enforcement.
 * It tells the model how to honor the ranking; it does not rewrite tool args or
 * guarantee the model complies. Hard enforcement (constraining or rewriting
 * tool arguments in `handleMCPToolCall`) is a larger, higher-risk follow-up and is
 * out of scope here. The portal currently emits only `order` (no `excluded`),
 * so exclusion is not handled.
 */

/** Opening marker of the portal's generated block. Kept in sync with the portal's `resource-priority.ts`. */
export const RESOURCE_PRIORITY_BEGIN = '<!-- bt:resource-priorities -->';
/** Closing marker of the portal's generated block. */
export const RESOURCE_PRIORITY_END = '<!-- /bt:resource-priorities -->';

/**
 * The machine-readable order line. Greedy capture to the line's last `]` so an
 * id containing `]` (e.g. `JSON.stringify(["aquifer:Notes]"])`) still parses —
 * mirrors the portal's own `ORDER_COMMENT_RE`.
 */
const ORDER_COMMENT_RE = /^<!--\s*order:\s*(\[.*\])\s*-->[ \t\r]*$/m;

/** A line that is only an opening/closing block marker. */
const MARKER_LINE_RE = /^[ \t]*<!--[ \t]*\/?bt:resource-priorities[ \t]*-->[ \t\r]*$/;
/** A line that is only the order comment. */
const ORDER_LINE_RE = /^[ \t]*<!--[ \t]*order:.*-->[ \t\r]*$/;

/**
 * The parsed ranking:
 * - `string[]` — the ordered `serverId:name` ids (may be empty)
 * - `'corrupt'` — a block is present but its order line is unreadable
 * - `null` — no resource-priority block at all
 */
export type PriorityOrder = readonly string[] | 'corrupt' | null;

/** Parse the ranking out of a `## Tool Guidance` slot value. */
export function parseResourcePriorityOrder(toolGuidance: string): PriorityOrder {
  if (typeof toolGuidance !== 'string' || !toolGuidance.includes(RESOURCE_PRIORITY_BEGIN)) {
    return null;
  }
  const match = ORDER_COMMENT_RE.exec(toolGuidance);
  if (!match?.[1]) return 'corrupt';
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    // A hand-mangled order line is reported as corrupt (the caller logs it),
    // not silently applied — we never act on an unreadable ranking.
    return 'corrupt';
  }
  if (!Array.isArray(parsed) || !parsed.every((id): id is string => typeof id === 'string')) {
    return 'corrupt';
  }
  return parsed;
}

/**
 * The `name` half of a `serverId:name` composite id. Split on the FIRST colon:
 * server ids carry no colon, so the remainder is the resource name even when the
 * name itself contains one.
 */
export function resourceNameFromId(id: string): string {
  const idx = id.indexOf(':');
  return idx === -1 ? id : id.slice(idx + 1);
}

/**
 * Render the actionable directive for a non-empty order, or `''` when it yields
 * no usable identifiers. Names are de-duplicated in first-seen order.
 */
export function renderResourcePriorityDirective(order: readonly string[]): string {
  const names: string[] = [];
  for (const id of order) {
    const name = resourceNameFromId(id).trim();
    if (name.length > 0 && !names.includes(name)) names.push(name);
  }
  if (names.length === 0) return '';

  return [
    '### Applying the resource priority',
    'The ranking above is not advisory background — act on it when you choose tools and resources.',
    'When a tool exposes a parameter that targets a specific resource — most importantly',
    "`fetch_scripture`'s `resource` parameter — set that parameter to request the ranked resources",
    `in priority order (${names.join(', ')}) rather than leaving it at the default that fetches`,
    'everything. Draw on the highest-ranked resource that covers the question, and fall back to a',
    'lower-ranked or unranked source only when the higher one does not. When your answer draws on',
    'anything other than the highest-ranked source, say so briefly in the same reply.',
  ].join('\n');
}

/** Outcome of {@link applyResourcePriority}. */
export interface AppliedResourcePriority {
  /** The transformed `tool_guidance` value (markers stripped; directive appended when applicable). */
  toolGuidance: string;
  /** What the parse found — so the caller can log the `'corrupt'` case. */
  order: PriorityOrder;
  /** True iff an actionable directive was appended. */
  applied: boolean;
}

/** Collapse runs of blank lines left behind by stripping marker lines. */
function collapseBlankRuns(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n');
}

/**
 * Transform a `## Tool Guidance` slot value for chat-time assembly: strip the
 * resource-priority block's HTML-comment markers (so they never reach the
 * model) and, when a usable ranking is present, append the actionable directive.
 *
 * Pure and non-mutating: returns the original string unchanged when there is no
 * block, so the common case is a cheap identity.
 */
export function applyResourcePriority(toolGuidance: string): AppliedResourcePriority {
  const order = parseResourcePriorityOrder(toolGuidance);
  if (order === null) {
    return { toolGuidance, order, applied: false };
  }

  // A block exists (readable or not) — always strip its markers so raw HTML
  // comments never leak into the prompt.
  const cleaned = collapseBlankRuns(
    toolGuidance
      .split('\n')
      .filter((line) => !MARKER_LINE_RE.test(line) && !ORDER_LINE_RE.test(line))
      .join('\n')
  ).trimEnd();

  if (order === 'corrupt' || order.length === 0) {
    return { toolGuidance: cleaned, order, applied: false };
  }

  const directive = renderResourcePriorityDirective(order);
  if (directive.length === 0) {
    return { toolGuidance: cleaned, order, applied: false };
  }

  return { toolGuidance: `${cleaned}\n\n${directive}`, order, applied: true };
}
