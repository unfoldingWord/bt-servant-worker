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
 *  1. It strips the block's HTML-comment marker lines so they never reach the
 *     model.
 *  2. When the order parses, it appends an actionable directive that lists the
 *     ranked resources by their full `serverId:name` identity — preserving both
 *     the ordering and which server each belongs to — and tells the model to
 *     honor the order through each tool's own resource selector, citing
 *     `fetch_scripture`'s `resource` parameter (whose values are resource names
 *     such as `ult`/`ust`) as the concrete scripture lever.
 *
 * Everything is SCOPED TO THE FENCED BLOCK: parsing and marker-stripping act
 * only on the region between a whole-line opening marker and its whole-line
 * closing marker, so an author's own `<!-- ... -->` line elsewhere in the slot,
 * or an `<!-- order: ... -->` outside the block, is left untouched.
 *
 * HONEST LIMITATION: this is strong prompt-bias, not server-side enforcement.
 * It tells the model how to honor the ranking; it does not rewrite tool args or
 * guarantee the model complies. Hard enforcement (constraining or rewriting
 * tool arguments in `handleMCPToolCall`) is a larger, higher-risk follow-up and
 * is out of scope here. The portal currently emits only `order` (no
 * `excluded`), so exclusion is not handled.
 */

/** Opening marker of the portal's generated block. Kept in sync with the portal's `resource-priority.ts`. */
export const RESOURCE_PRIORITY_BEGIN = '<!-- bt:resource-priorities -->';
/** Closing marker of the portal's generated block. */
export const RESOURCE_PRIORITY_END = '<!-- /bt:resource-priorities -->';

// Whole-line markers. Indent- and CRLF-tolerant, and tested one line at a time
// (no `/m`) so detection is anchored to a line being ONLY a marker — a prose
// mention of the marker text does not count.
const BEGIN_LINE_RE = /^[ \t]*<!--[ \t]*bt:resource-priorities[ \t]*-->[ \t\r]*$/;
const END_LINE_RE = /^[ \t]*<!--[ \t]*\/bt:resource-priorities[ \t]*-->[ \t\r]*$/;
// The machine-readable order line. Greedy capture to the line's last `]` so an
// id containing `]` still parses. Indent-tolerant, matching the marker lines.
const ORDER_LINE_RE = /^[ \t]*<!--[ \t]*order:[ \t]*(\[.*\])[ \t]*-->[ \t\r]*$/;

/**
 * The parsed ranking:
 * - `string[]` — the ordered `serverId:name` ids (may be empty)
 * - `'corrupt'` — a block is present but its order line is unreadable
 * - `null` — no resource-priority block at all
 */
export type PriorityOrder = readonly string[] | 'corrupt' | null;

/** Line-index bounds of the fenced block; `end` is `null` for an orphan opening marker. */
interface BlockBounds {
  begin: number;
  end: number | null;
}

/** Locate the first whole-line opening marker and its following closing marker. */
function findBlockBounds(lines: readonly string[]): BlockBounds | null {
  const begin = lines.findIndex((line) => BEGIN_LINE_RE.test(line));
  if (begin === -1) return null;
  for (let i = begin + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line !== undefined && END_LINE_RE.test(line)) {
      return { begin, end: i };
    }
  }
  return { begin, end: null };
}

/** Parse the order comment out of the block's own lines (never `null` — a block is present). */
function parseOrderFromBlockLines(blockLines: readonly string[]): readonly string[] | 'corrupt' {
  let raw: string | undefined;
  for (const line of blockLines) {
    const match = ORDER_LINE_RE.exec(line);
    if (match?.[1]) {
      raw = match[1];
      break;
    }
  }
  if (raw === undefined) return 'corrupt';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
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

/** Parse the ranking out of a `## Tool Guidance` slot value (block-scoped). */
export function parseResourcePriorityOrder(toolGuidance: string): PriorityOrder {
  if (typeof toolGuidance !== 'string') return null;
  const lines = toolGuidance.split('\n');
  const bounds = findBlockBounds(lines);
  if (!bounds) return null;
  if (bounds.end === null) return 'corrupt';
  return parseOrderFromBlockLines(lines.slice(bounds.begin, bounds.end + 1));
}

/** Split a `serverId:name` composite on its FIRST colon (server ids carry none). */
export function splitResourceId(id: string): { serverId: string; name: string } {
  const idx = id.indexOf(':');
  if (idx === -1) return { serverId: '', name: id };
  return { serverId: id.slice(0, idx), name: id.slice(idx + 1) };
}

/** The `name` half of a `serverId:name` composite id. */
export function resourceNameFromId(id: string): string {
  return splitResourceId(id).name;
}

const DIRECTIVE_HEADING = '### Applying the resource priority';

/**
 * Render the actionable directive for a non-empty order, or `''` when it yields
 * no usable ids. Entries are de-duplicated by their FULL composite id, so the
 * same resource name under two different servers keeps both ranking positions.
 * Each entry shows `name — serverId`, preserving which server (and therefore
 * which tool) a resource belongs to, so the model never sends one server's
 * resource name to another server's tool.
 */
export function renderResourcePriorityDirective(order: readonly string[]): string {
  const seen = new Set<string>();
  const ranked: string[] = [];
  for (const rawId of order) {
    const id = rawId.trim();
    if (id.length === 0 || seen.has(id)) continue;
    const { serverId, name } = splitResourceId(id);
    if (name.trim().length === 0) continue;
    seen.add(id);
    const position = ranked.length + 1;
    ranked.push(
      serverId.length > 0
        ? `${position}. ${name.trim()} — ${serverId}`
        : `${position}. ${name.trim()}`
    );
  }
  if (ranked.length === 0) return '';

  return [
    DIRECTIVE_HEADING,
    'Honor the ranking below when you choose tools and resources — it is not advisory background.',
    'Prefer the highest-ranked resource that covers the question, and fall back to a lower-ranked or',
    'unranked source only when it does not. When your answer draws on anything other than the',
    'highest-ranked source, say so briefly in the same reply.',
    'When a tool exposes a parameter that targets a specific resource, set it to honor this order —',
    "for scripture, `fetch_scripture`'s `resource` parameter takes resource names such as `ult`,",
    '`ust`, `t4t`, `ueb`. Match each resource below to the tool from its server; never pass one',
    "server's resource name to another server's tool.",
    'Ranked resources, most preferred first:',
    ...ranked,
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

/** Join non-empty segments with exactly one blank line between them. */
function assembleSlot(before: string, middle: string, after: string): string {
  const head = before.replace(/[ \t\r\n]+$/, '');
  const tail = after.replace(/^[ \t\r\n]+/, '');
  const parts = [head, middle, tail].filter((part) => part.length > 0);
  return collapseBlankRuns(parts.join('\n\n')).trimEnd();
}

/**
 * Transform a `## Tool Guidance` slot value for chat-time assembly: within the
 * fenced resource-priority block, strip the HTML-comment markers (so they never
 * reach the model) and, when a usable ranking is present, replace the block with
 * its prose plus the actionable directive. Everything outside the block — the
 * author's own guidance, including any of their own HTML comments — is
 * untouched.
 *
 * Pure and non-mutating: returns the original string unchanged when there is no
 * block, so the common case is a cheap identity.
 */
export function applyResourcePriority(toolGuidance: string): AppliedResourcePriority {
  if (typeof toolGuidance !== 'string') {
    return { toolGuidance, order: null, applied: false };
  }
  const lines = toolGuidance.split('\n');
  const bounds = findBlockBounds(lines);
  if (!bounds) {
    return { toolGuidance, order: null, applied: false };
  }

  // Orphan opening marker (no closing): strip the opening marker and any order
  // line at or after it so raw comments don't leak, but trust nothing — no
  // directive. Author prose is preserved (only marker/order lines are dropped).
  if (bounds.end === null) {
    const kept = lines.filter((line, index) => {
      if (index < bounds.begin) return true;
      return !BEGIN_LINE_RE.test(line) && !ORDER_LINE_RE.test(line);
    });
    return {
      toolGuidance: collapseBlankRuns(kept.join('\n')).trimEnd(),
      order: 'corrupt',
      applied: false,
    };
  }

  const blockLines = lines.slice(bounds.begin, bounds.end + 1);
  const order = parseOrderFromBlockLines(blockLines);

  // Rebuild the block from its prose only (drop the three machine lines).
  const prose = blockLines
    .filter(
      (line) => !BEGIN_LINE_RE.test(line) && !END_LINE_RE.test(line) && !ORDER_LINE_RE.test(line)
    )
    .join('\n')
    .trim();

  let middle = prose;
  let applied = false;
  if (order !== 'corrupt' && order.length > 0) {
    const directive = renderResourcePriorityDirective(order);
    if (directive.length > 0) {
      middle = prose.length > 0 ? `${prose}\n\n${directive}` : directive;
      applied = true;
    }
  }

  const before = lines.slice(0, bounds.begin).join('\n');
  const after = lines.slice(bounds.end + 1).join('\n');
  return { toolGuidance: assembleSlot(before, middle, after), order, applied };
}
