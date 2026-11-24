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
  | { type: 'malformed_token' }
  | { type: 'truncated_token' };

export interface FilterOutput {
  text: string;
  events: RelayEvent[];
}

const RELAY_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_TOKEN_CHARS = 200;
const MAX_BLOCKS_PER_TURN = 200;
const MAX_BYTES_PER_TURN = 64 * 1024;
const OPENING_RE = /^\{\{ {0,3}relay {0,3}:/i;

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
  if (serverIds.length === 0) return false;
  const allowed = new Set(serverIds);
  return catalog.tools.some((t) => allowed.has(t.serverId));
}

export function parseRelayBlocks(meta: unknown, logger: RelayLogger): RelayBlock[] {
  if (!Array.isArray(meta)) return [];
  const out: RelayBlock[] = [];
  for (const item of meta) {
    if (!item || typeof item !== 'object') {
      logger.warn('relay_invalid_block', { reason: 'not_object' });
      continue;
    }
    const rec = item as Record<string, unknown>;
    const id = rec.id;
    const text = rec.text;
    if (typeof id !== 'string' || !RELAY_ID_RE.test(id) || typeof text !== 'string') {
      logger.warn('relay_invalid_block', {
        reason: 'bad_shape',
        id: typeof id === 'string' ? id.slice(0, 64) : typeof id,
      });
      continue;
    }
    out.push({ id, text });
  }
  return out;
}

/**
 * One collector per `tool_use`. Closed when that call finishes; late adds are
 * discarded (`relay_late_block`).
 */
export class RelayCollector {
  private readonly _blocks: RelayBlock[] = [];
  private closed = false;

  get blocks(): readonly RelayBlock[] {
    return this._blocks;
  }

  add(block: RelayBlock, logger?: RelayLogger): void {
    if (this.closed) {
      logger?.warn('relay_late_block', { id: block.id });
      return;
    }
    this._blocks.push(block);
  }

  close(): void {
    this.closed = true;
  }
}

/**
 * Turn-scoped id → text map. Collectors are ingested once after the round's
 * `Promise.all`, in `tool_use` order.
 */
export class RelayRegistry {
  private readonly map = new Map<string, string>();
  private blockCount = 0;
  private byteCount = 0;

  get(id: string): string | undefined {
    return this.map.get(id);
  }

  /**
   * Ingest collectors in order. Returns the accepted ids for each collector
   * (id whose stored text is exactly that collector's text for the id).
   */
  ingestCollectors(collectors: readonly RelayCollector[], logger: RelayLogger): string[][] {
    return collectors.map((collector) => this.ingestOne(collector, logger));
  }

  private ingestOne(collector: RelayCollector, logger: RelayLogger): string[] {
    const accepted: string[] = [];
    const seenInCollector = new Map<string, string>();

    for (const block of collector.blocks) {
      const priorInCollector = seenInCollector.get(block.id);
      if (priorInCollector !== undefined) {
        if (priorInCollector !== block.text) {
          logger.warn('relay_id_conflict', { id: block.id });
        }
        continue;
      }
      seenInCollector.set(block.id, block.text);

      const existing = this.map.get(block.id);
      if (existing !== undefined) {
        if (existing !== block.text) {
          logger.warn('relay_id_conflict', { id: block.id });
          continue;
        }
        accepted.push(block.id);
        continue;
      }

      const bytes = new TextEncoder().encode(block.text).length;
      if (this.blockCount >= MAX_BLOCKS_PER_TURN || this.byteCount + bytes > MAX_BYTES_PER_TURN) {
        logger.warn('relay_limit_exceeded', {
          id: block.id,
          block_count: this.blockCount,
          byte_count: this.byteCount,
        });
        continue;
      }

      this.map.set(block.id, block.text);
      this.blockCount += 1;
      this.byteCount += bytes;
      accepted.push(block.id);
    }
    return accepted;
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

interface DrainCtx {
  buf: string;
  out: string;
  events: RelayEvent[];
  eof: boolean;
  usedIds: Set<string>;
  registry: RelayRegistry;
}

/**
 * Streaming substitution. Returns text to emit and events for the caller to
 * log (the filter itself never logs). Inserted text is never rescanned.
 */
export class RelayStreamFilter {
  private buf = '';
  private readonly usedIds = new Set<string>();
  private readonly registry: RelayRegistry;

  constructor(registry: RelayRegistry) {
    this.registry = registry;
  }

  push(delta: string): FilterOutput {
    this.buf += delta;
    return this.drain(false);
  }

  flush(): FilterOutput {
    return this.drain(true);
  }

  private drain(eof: boolean): FilterOutput {
    const ctx: DrainCtx = {
      buf: this.buf,
      out: '',
      events: [],
      eof,
      usedIds: this.usedIds,
      registry: this.registry,
    };
    while (drainStep(ctx)) {
      /* keep draining */
    }
    this.buf = ctx.buf;
    return { text: ctx.out, events: ctx.events };
  }
}

/** One drain step. Returns false when the buffer must wait or is empty. */
function drainStep(ctx: DrainCtx): boolean {
  const brace = ctx.buf.indexOf('{');
  if (brace === -1) {
    ctx.out += ctx.buf;
    ctx.buf = '';
    return false;
  }
  if (brace > 0) {
    ctx.out += ctx.buf.slice(0, brace);
    ctx.buf = ctx.buf.slice(brace);
  }

  const opening = matchOpening(ctx.buf);
  if (opening === 'prefix') {
    if (!ctx.eof) return false;
    ctx.out += ctx.buf;
    ctx.buf = '';
    return false;
  }
  if (opening === null) return emitRejectedBrace(ctx);

  return resolveOpenedToken(ctx, opening.end);
}

/** Not a possible opening: emit through the next `{` and continue. */
function emitRejectedBrace(ctx: DrainCtx): boolean {
  const next = ctx.buf.indexOf('{', 1);
  if (next === -1) {
    ctx.out += ctx.buf;
    ctx.buf = '';
    return false;
  }
  ctx.out += ctx.buf.slice(0, next);
  ctx.buf = ctx.buf.slice(next);
  return true;
}

function resolveOpenedToken(ctx: DrainCtx, openingEnd: number): boolean {
  // A token (valid or malformed-through-}}) must finish within 200 chars of the
  // opening start. Beyond that window: emit through the next `{` and rescan.
  const maxBody = MAX_TOKEN_CHARS - openingEnd;
  const body = matchTokenBody(ctx.buf.slice(openingEnd), maxBody);
  if (body === 'need_more') return resolveIncompleteBody(ctx, openingEnd);
  if (body === 'oversize') return emitRejectedBrace(ctx);

  ctx.buf = ctx.buf.slice(openingEnd + body.end);
  if (body.kind === 'malformed') {
    ctx.events.push({ type: 'malformed_token' });
    return true;
  }
  applyValidId(ctx, body.id);
  return true;
}

function resolveIncompleteBody(ctx: DrainCtx, openingEnd: number): boolean {
  if (!ctx.eof && ctx.buf.length < MAX_TOKEN_CHARS) return false;
  if (!ctx.eof && ctx.buf.length >= MAX_TOKEN_CHARS) {
    return emitRejectedBrace(ctx);
  }
  if (isTruncatedValidToken(ctx.buf, openingEnd)) {
    ctx.events.push({ type: 'truncated_token' });
    ctx.buf = '';
    return false;
  }
  ctx.out += ctx.buf;
  ctx.buf = '';
  return false;
}

function applyValidId(ctx: DrainCtx, id: string): void {
  if (!id || !RELAY_ID_RE.test(id)) {
    ctx.events.push({ type: 'malformed_token' });
    return;
  }
  if (ctx.usedIds.has(id)) {
    ctx.events.push({ type: 'repeated_id', id });
    return;
  }
  const text = ctx.registry.get(id);
  if (text === undefined) {
    ctx.events.push({ type: 'unknown_id', id });
    return;
  }
  ctx.usedIds.add(id);
  ctx.out += text;
}

/**
 * expandRelayText = new filter, push(text)+flush(). The only substitution
 * implementation for final responses. Returns text and events so callers can
 * inspect unknown ids without a second scan.
 */
export function expandRelayBlock(
  text: string,
  registry: RelayRegistry
): { text: string; events: RelayEvent[] } {
  const filter = new RelayStreamFilter(registry);
  const a = filter.push(text);
  const b = filter.flush();
  return { text: a.text + b.text, events: [...a.events, ...b.events] };
}

/** expandRelayBlock + log relay_* events once per block. */
export function expandRelayText(
  text: string,
  registry: RelayRegistry,
  logger: RelayLogger
): string {
  const { text: out, events } = expandRelayBlock(text, registry);
  logRelayEvents(logger, events);
  return out;
}

function logRelayEvents(logger: RelayLogger, events: readonly RelayEvent[]): void {
  for (const e of events) {
    if (e.type === 'unknown_id') logger.warn('relay_unknown_id', { id: e.id });
    else if (e.type === 'repeated_id') logger.warn('relay_repeated_id', { id: e.id });
    else if (e.type === 'malformed_token') logger.warn('relay_malformed_token', {});
    else if (e.type === 'truncated_token') logger.warn('relay_truncated_token', {});
  }
}

/** Opening: `{{`, ≤3 spaces, `relay` (any case), ≤3 spaces, `:`. */
function matchOpening(s: string): { end: number } | 'prefix' | null {
  const full = OPENING_RE.exec(s);
  if (full && full.index === 0) return { end: full[0].length };
  if (isOpeningPrefix(s)) return 'prefix';
  return null;
}

function isOpeningPrefix(s: string): boolean {
  if (!s.startsWith('{')) return false;
  if (s.length === 1) return true;
  if (s[1] !== '{') return false;
  return isOpeningPrefixAfterBraces(s.slice(2));
}

function isOpeningPrefixAfterBraces(rest: string): boolean {
  const afterSpaces = skipUpTo3Spaces(rest);
  if (!afterSpaces) return false;
  const rem = afterSpaces.remainder;
  if (rem.length === 0) return true;
  const lower = rem.toLowerCase();
  if ('relay'.startsWith(lower)) return true;
  if (!lower.startsWith('relay')) return false;
  const afterRelay = skipUpTo3Spaces(rem.slice(5));
  return afterRelay !== null && afterRelay.remainder.length === 0;
}

/** Returns null on a 4th space; otherwise the string after ≤3 leading spaces. */
function skipUpTo3Spaces(s: string): { remainder: string } | null {
  let i = 0;
  while (i < s.length && s[i] === ' ' && i < 3) i += 1;
  if (i < s.length && s[i] === ' ' && i === 3) return null;
  return { remainder: s.slice(i) };
}

type TokenBody =
  | { kind: 'valid'; id: string; end: number }
  | { kind: 'malformed'; end: number }
  | 'need_more'
  | 'oversize';

function matchTokenBody(s: string, maxBody: number): TokenBody {
  const lead = takeSpaces(s, 0);
  if (lead.overflow) return scanMalformed(s, maxBody);
  const idPart = takeIdChars(s, lead.end);
  const trail = takeSpaces(s, idPart.end);
  if (trail.overflow) return scanMalformed(s, maxBody);
  return finishTokenBody(s, trail.end, idPart.value, maxBody);
}

function needMoreOrOversize(s: string, maxBody: number): 'need_more' | 'oversize' {
  return s.length >= maxBody ? 'oversize' : 'need_more';
}

function finishTokenBody(s: string, start: number, id: string, maxBody: number): TokenBody {
  if (start < s.length && isIdChar(s[start]!)) return scanMalformed(s, maxBody);
  const closed = matchClosingBraces(s, start);
  if (closed === 'need_more') return needMoreOrOversize(s, maxBody);
  if (closed === 'malformed') return scanMalformed(s, maxBody);
  if (closed.end > maxBody) return 'oversize';
  if (id.length === 0 || id.length > 128 || !RELAY_ID_RE.test(id)) {
    return { kind: 'malformed', end: closed.end };
  }
  return { kind: 'valid', id, end: closed.end };
}

/** Consume `}}` starting at `start`, or signal need_more / malformed. */
function matchClosingBraces(s: string, start: number): { end: number } | 'need_more' | 'malformed' {
  if (start >= s.length) return 'need_more';
  if (s[start] !== '}') return 'malformed';
  if (start + 1 >= s.length) return 'need_more';
  if (s[start + 1] !== '}') return 'malformed';
  return { end: start + 2 };
}

function takeSpaces(s: string, start: number): { end: number; overflow: boolean } {
  let i = start;
  let n = 0;
  while (i < s.length && s[i] === ' ' && n < 3) {
    n += 1;
    i += 1;
  }
  return { end: i, overflow: i < s.length && s[i] === ' ' && n === 3 };
}

function takeIdChars(s: string, start: number): { end: number; value: string } {
  let i = start;
  while (i < s.length && isIdChar(s[i]!)) i += 1;
  return { end: i, value: s.slice(start, i) };
}

/**
 * Look for `}}` only inside the 200-char window from the opening start
 * (`maxBody` chars of body). A later `}}` must not swallow a following token.
 */
function scanMalformed(s: string, maxBody: number): TokenBody {
  const window = s.slice(0, Math.max(0, maxBody));
  const close = window.indexOf('}}');
  if (close !== -1) return { kind: 'malformed', end: close + 2 };
  if (s.length >= maxBody) return 'oversize';
  return 'need_more';
}

function isIdChar(ch: string): boolean {
  return /[A-Za-z0-9._-]/.test(ch);
}

/**
 * At EOF: retained buffer is a truncated valid token when it has a complete
 * opening plus ` {0,3} idchars{0,128} {0,3} }? ` and nothing else.
 */
function isTruncatedValidToken(buf: string, openingEnd: number): boolean {
  return /^ {0,3}[A-Za-z0-9._-]{0,128} {0,3}\}?$/.test(buf.slice(openingEnd));
}
