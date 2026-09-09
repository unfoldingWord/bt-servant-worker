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
// The machine-readable order line, for PARSING. Greedy capture to the line's
// last `]` so an id containing `]` still parses. Indent-tolerant.
const ORDER_LINE_RE = /^[ \t]*<!--[ \t]*order:[ \t]*(\[.*\])[ \t]*-->[ \t\r]*$/;
// A broader matcher for STRIPPING: any `<!-- order: ... -->` line, even one too
// malformed to parse (e.g. `<!-- order: not-json -->`). Parsing stays strict via
// ORDER_LINE_RE; stripping must be broad so a corrupt machine comment inside the
// block never leaks into the prompt.
const ORDER_STRIP_RE = /^[ \t]*<!--[ \t]*order:.*-->[ \t\r]*$/;

/** True for any block machine line (opening/closing marker or an order comment). */
function isBlockMachineLine(line: string): boolean {
  return BEGIN_LINE_RE.test(line) || END_LINE_RE.test(line) || ORDER_STRIP_RE.test(line);
}

/**
 * The parsed ranking:
 * - `string[]` — the ordered `serverId:name` ids (may be empty)
 * - `'corrupt'` — a block is present but its order line is unreadable
 * - `null` — no resource-priority block at all
 */
export type PriorityOrder = readonly string[] | 'corrupt' | null;

/** A well-formed block: its opening, closing, and single order-comment line indices. */
interface WellFormedBlock {
  begin: number;
  end: number;
  order: number;
}

/** Line indices of every whole-line opening, closing, and order marker. */
interface Markers {
  begins: number[];
  ends: number[];
  orders: number[];
}

/** Collect the line indices of every whole-line marker. A line is one kind at most. */
function collectMarkers(lines: readonly string[]): Markers {
  const begins: number[] = [];
  const ends: number[] = [];
  const orders: number[] = [];
  lines.forEach((line, index) => {
    if (BEGIN_LINE_RE.test(line)) begins.push(index);
    else if (END_LINE_RE.test(line)) ends.push(index);
    else if (ORDER_STRIP_RE.test(line)) orders.push(index);
  });
  return { begins, ends, orders };
}

/**
 * The one well-formed block, or `null` when the marker structure is ambiguous.
 *
 * The only valid shape is exactly one opening marker, exactly one closing marker
 * after it, and exactly one order comment strictly between them. Anything else —
 * multiple blocks, a nested opener, an orphan opener, a stray closer, or zero /
 * multiple order comments (from a hand-edit or merge conflict) — is ambiguous
 * and rejected, so we can never apply a guessed ranking.
 */
function wellFormedBlock(markers: Markers): WellFormedBlock | null {
  if (markers.begins.length !== 1 || markers.ends.length !== 1) return null;
  const begin = markers.begins[0]!;
  const end = markers.ends[0]!;
  if (begin >= end) return null;
  const inside = markers.orders.filter((index) => index > begin && index < end);
  if (inside.length !== 1) return null;
  return { begin, end, order: inside[0]! };
}

/** Parse a single order-comment line into ids, or `'corrupt'`. */
function parseOrderLine(line: string): readonly string[] | 'corrupt' {
  const match = ORDER_LINE_RE.exec(line);
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

/** Parse the ranking out of a `## Tool Guidance` slot value (block-scoped). */
export function parseResourcePriorityOrder(toolGuidance: string): PriorityOrder {
  if (typeof toolGuidance !== 'string') return null;
  const lines = toolGuidance.split('\n');
  const markers = collectMarkers(lines);
  if (markers.begins.length === 0) return null; // no block opener → not a block
  const block = wellFormedBlock(markers);
  if (!block) return 'corrupt';
  return parseOrderLine(lines[block.order] ?? '');
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
    'highest-ranked source that covers the question, say so briefly in the same reply.',
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

/** Drop leading blank lines while preserving indentation on the first content line. */
function dropLeadingBlankLines(text: string): string {
  const lines = text.split('\n');
  let start = 0;
  for (const line of lines) {
    if (line.trim().length > 0) break;
    start += 1;
  }
  return lines.slice(start).join('\n');
}

/** Join non-empty segments with exactly one blank line between them. */
function assembleSlot(before: string, middle: string, after: string): string {
  const head = before.replace(/[ \t\r\n]+$/, '');
  const tail = dropLeadingBlankLines(after);
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
  const markers = collectMarkers(lines);
  if (markers.begins.length === 0) {
    return { toolGuidance, order: null, applied: false };
  }

  const block = wellFormedBlock(markers);

  // Ambiguous marker structure (multiple/nested blocks, an orphan opener, a
  // stray closer, or not exactly one order comment): we won't guess a ranking.
  // Strip every machine line within the span the markers occupy so none leaks —
  // content OUTSIDE that span, including the author's own comments, is left
  // untouched — and report corrupt.
  if (!block) {
    const marked = [...markers.begins, ...markers.ends, ...markers.orders];
    const lo = Math.min(...marked);
    const hi = Math.max(...marked);
    const kept = lines.filter(
      (line, index) => !(index >= lo && index <= hi && isBlockMachineLine(line))
    );
    return {
      toolGuidance: collapseBlankRuns(kept.join('\n')).trimEnd(),
      order: 'corrupt',
      applied: false,
    };
  }

  const order = parseOrderLine(lines[block.order] ?? '');

  // Rebuild the block from its prose only (drop the machine lines — markers and
  // the order comment, including a malformed one that failed strict parsing).
  const prose = lines
    .slice(block.begin, block.end + 1)
    .filter((line) => !isBlockMachineLine(line))
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

  const before = lines.slice(0, block.begin).join('\n');
  const after = lines.slice(block.end + 1).join('\n');
  return { toolGuidance: assembleSlot(before, middle, after), order, applied };
}
