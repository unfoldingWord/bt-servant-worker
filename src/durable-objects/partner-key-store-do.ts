/**
 * PartnerKeyStoreDO (admin-portal#354): the single writer for partner API key
 * administration. One instance (`idFromName('global')`) owns create, rotate,
 * revoke, get and list, with its own transactional storage as the source of
 * truth. The operations themselves live in PartnerKeyLedger.
 *
 * Serialisation: a Durable Object's input gate only holds while it waits on
 * its OWN storage; the KV projection writes are external I/O, during which
 * another request could start. So every operation (and the alarm) runs
 * through `serialize`, a promise chain: one operation at a time, start to
 * finish, including its KV writes. Admin traffic is tiny, so the queue costs
 * nothing in practice and makes every operation straight-line code.
 *
 * Alarm: retries KV projections that failed (see ledger.ts).
 *
 * Reached only from the worker (partnerKeyStore in services/partner-keys/
 * store.ts) after the admin guard; a DO has no public address.
 */

import type { Env } from '../config/types.js';
import { PartnerKeyLedger } from '../services/partner-keys/ledger.js';
import type { PartnerKeyStoreOp } from '../services/partner-keys/store.js';
import { createRequestLogger, type RequestLogger } from '../utils/logger.js';

/** The operation in a request body, or null when it is not a JSON object with an `op`. */
async function readOp(request: Request): Promise<PartnerKeyStoreOp | null> {
  try {
    const body: unknown = await request.json();
    const ok = typeof body === 'object' && body !== null && 'op' in body;
    return ok ? (body as PartnerKeyStoreOp) : null;
  } catch {
    return null;
  }
}

export class PartnerKeyStoreDO {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const logger = createRequestLogger(request.headers.get('X-Request-ID') ?? crypto.randomUUID());
    const op = await readOp(request);
    if (!op) return Response.json({ error: 'Body must be a JSON operation' }, { status: 400 });
    try {
      const result = await this.serialize(() => this.run(op, logger));
      return result === undefined
        ? Response.json({ error: `Unknown operation '${String(op.op)}'` }, { status: 400 })
        : Response.json(result);
    } catch (error) {
      logger.error('partner_key_store_failed', error, { op: op.op });
      return Response.json({ error: 'Partner key store operation failed' }, { status: 500 });
    }
  }

  async alarm(): Promise<void> {
    const logger = createRequestLogger(crypto.randomUUID());
    await this.serialize(() => this.ledger(logger).retryProjections());
  }

  /** Run `task` after every earlier task has settled; a failure does not block later ones. */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private ledger(logger: RequestLogger): PartnerKeyLedger {
    return new PartnerKeyLedger(
      this.state.storage,
      this.env.API_KEYS,
      this.env.PARTNER_KEY_TAG_SECRET,
      logger
    );
  }

  /** Dispatch one operation; undefined for an unknown op. */
  private async run(op: PartnerKeyStoreOp, logger: RequestLogger): Promise<unknown> {
    const ledger = this.ledger(logger);
    switch (op.op) {
      case 'create':
        return ledger.create(op.input);
      case 'list':
        return { records: await ledger.list(op.org) };
      case 'get':
        return { record: (await ledger.get(op.id))?.record ?? null };
      case 'revoke':
        return ledger.revoke(op.id, op.revokedBy);
      case 'rotate':
        return ledger.rotate(op.id, { createdBy: op.createdBy, graceSeconds: op.graceSeconds });
      default:
        return undefined;
    }
  }
}
