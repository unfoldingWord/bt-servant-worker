/**
 * Verbatim relay tokens (#462).
 *
 * MCP tools may publish `{ id, text }` blocks in `_meta["bt/relay"]`. The model
 * writes `{{relay:<id>}}`; this module substitutes the exact published text in
 * streaming and in the final response. No orchestrator imports — callers wire it.
 */

import type { ToolCatalog } from '../mcp/types.js';

/** Minimal logger surface used by relay (avoids coupling to RequestLogger internals). */
export interface RelayLogger {
  warn: (event: string, data?: Record<string, unknown>) => void;
}

export interface RelayBlock {
  id: string;
  text: string;
}

export type RelayEvent =
  | { type: 'unknown_id'; id: string }
  | { type: 'repeated_id'; id: string }
  | { type: 'truncated_token' };

export interface FilterOutput {
  text: string;
  events: RelayEvent[];
}

const RELAY_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_BLOCKS_PER_TURN = 200;
const MAX_BYTES_PER_TURN = 64 * 1024;
/** A whole token at the start of the buffer. */
const TOKEN_RE = /^\{\{relay:([A-Za-z0-9._-]{1,128})\}\}/;
const TOKEN_HEAD = '{{relay:';

/** The whole buffer could still grow into a token: `{`, `{{rel`, `{{relay:ab}`… */
function isTokenPrefix(buf: string): boolean {
  if (buf.length <= TOKEN_HEAD.length) return TOKEN_HEAD.startsWith(buf);
  return (
    buf.startsWith(TOKEN_HEAD) && /^[A-Za-z0-9._-]{1,128}\}?$/.test(buf.slice(TOKEN_HEAD.length))
  );
}

/** Parse `RELAY_SERVER_IDS` (comma-separated, whitespace trimmed). */
export function parseRelayServerIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Relay is active for a turn when the env list is non-empty and the catalog
 * offers at least one tool from a listed server. Fixed for the turn.
 */
export function isRelayActive(serverIds: readonly string[], catalog: ToolCatalog): boolean {
  const allowed = new Set(serverIds);
  return catalog.tools.some((t) => allowed.has(t.serverId));
}

function isRelayBlock(item: unknown): item is RelayBlock {
  const rec = item as { id?: unknown; text?: unknown } | null;
  return (
    typeof rec === 'object' &&
    rec !== null &&
    typeof rec.id === 'string' &&
    RELAY_ID_RE.test(rec.id) &&
    typeof rec.text === 'string'
  );
}

/** Shape-check `_meta["bt/relay"]`; invalid items are dropped and counted. */
export function parseRelayBlocks(meta: unknown, logger: RelayLogger): RelayBlock[] {
  if (!Array.isArray(meta)) return [];
  const blocks = meta.filter(isRelayBlock).map(({ id, text }) => ({ id, text }));
  if (blocks.length < meta.length) {
    logger.warn('relay_invalid_block', { dropped: meta.length - blocks.length });
  }
  return blocks;
}

/**
 * One collector per `tool_use`. Closed when that call finishes; a late add (a
 * sandbox host call that outlived its timeout) is discarded (`relay_late_block`).
 */
export class RelayCollector {
  readonly blocks: RelayBlock[] = [];
  private closed = false;

  add(block: RelayBlock, logger?: RelayLogger): void {
    if (this.closed) logger?.warn('relay_late_block', { id: block.id });
    else this.blocks.push(block);
  }

  close(): void {
    this.closed = true;
  }
}

/**
 * Turn-scoped id → text map. Collectors are ingested once after the round's
 * `Promise.all`, in `tool_use` order. The first text for an id wins.
 */
export class RelayRegistry {
  private readonly map = new Map<string, string>();
  private bytes = 0;

  get(id: string): string | undefined {
    return this.map.get(id);
  }

  /** Per collector, the ids whose stored text is that collector's text. */
  ingestCollectors(collectors: readonly RelayCollector[], logger: RelayLogger): string[][] {
    return collectors.map((c) => [
      ...new Set(c.blocks.filter((b) => this.add(b, logger)).map((b) => b.id)),
    ]);
  }

  private add(block: RelayBlock, logger: RelayLogger): boolean {
    const existing = this.map.get(block.id);
    if (existing !== undefined) {
      if (existing !== block.text) logger.warn('relay_id_conflict', { id: block.id });
      return existing === block.text;
    }
    const size = new TextEncoder().encode(block.text).length;
    if (this.map.size >= MAX_BLOCKS_PER_TURN || this.bytes + size > MAX_BYTES_PER_TURN) {
      logger.warn('relay_limit_exceeded', { id: block.id });
      return false;
    }
    this.map.set(block.id, block.text);
    this.bytes += size;
    return true;
  }
}

/** Exact note appended to a tool_result (ids only). */
export function formatRelayNote(ids: readonly string[]): string {
  const tokens = ids.map((id) => `{{relay:${id}}}`).join(' ');
  return (
    `\n\n[Relay blocks from this tool call. To show one exactly, write its token: ` +
    `${tokens}. Do not retype this text. These ids work only in this turn.]`
  );
}

/**
 * Streaming substitution. Text without `{` passes at once; text is held only
 * while it could still become a token (at most ~140 chars). Returns events for
 * the caller to log (the filter never logs). Inserted text is never rescanned.
 */
export class RelayStreamFilter {
  private buf = '';
  private readonly used = new Set<string>();
  private readonly registry: RelayRegistry;

  constructor(registry: RelayRegistry) {
    this.registry = registry;
  }

  push(delta: string): FilterOutput {
    this.buf += delta;
    return this.drain(false);
  }

  /** End of the text block: a cut `{{relay:…` is removed, any other held text is emitted. */
  flush(): FilterOutput {
    return this.drain(true);
  }

  private drain(eof: boolean): FilterOutput {
    const out: FilterOutput = { text: '', events: [] };
    for (let brace = this.buf.indexOf('{'); brace !== -1; brace = this.buf.indexOf('{')) {
      out.text += this.buf.slice(0, brace);
      this.buf = this.buf.slice(brace);
      const token = TOKEN_RE.exec(this.buf);
      if (token) {
        this.buf = this.buf.slice(token[0].length);
        out.text += this.expand(token[1]!, out.events);
      } else if (!isTokenPrefix(this.buf)) {
        out.text += '{';
        this.buf = this.buf.slice(1);
      } else if (!eof) {
        return out;
      } else {
        if (this.buf.startsWith(TOKEN_HEAD)) out.events.push({ type: 'truncated_token' });
        else out.text += this.buf;
        this.buf = '';
      }
    }
    out.text += this.buf;
    this.buf = '';
    return out;
  }

  /** Unknown ids and repeats within one text block expand to nothing. */
  private expand(id: string, events: RelayEvent[]): string {
    const text = this.registry.get(id);
    if (text === undefined) {
      events.push({ type: 'unknown_id', id });
      return '';
    }
    if (this.used.has(id)) {
      events.push({ type: 'repeated_id', id });
      return '';
    }
    this.used.add(id);
    return text;
  }
}

/** Whole-text expansion: a new filter, push + flush (same code as streaming). */
export function expandRelayBlock(text: string, registry: RelayRegistry): FilterOutput {
  const filter = new RelayStreamFilter(registry);
  const a = filter.push(text);
  const b = filter.flush();
  return { text: a.text + b.text, events: [...a.events, ...b.events] };
}
