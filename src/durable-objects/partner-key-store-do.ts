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
 * Alarm: retries owed KV projections (see ledger.ts).
 *
 * Reached only from the worker (partnerKeyStore in services/partner-keys/
 * store.ts) after the admin guard; a DO has no public address.
 */

import type { Env } from '../config/types.js';
import { PartnerKeyLedger } from '../services/partner-keys/ledger.js';
import {
  flushLogTelemetry,
  flushMetricTelemetry,
  initLogTelemetry,
  initMetricTelemetry,
  runWithMetricsSuppressed,
} from '../services/telemetry/index.js';
import type { PartnerKeyStoreOp } from '../services/partner-keys/store.js';
import { createRequestLogger, type RequestLogger } from '../utils/logger.js';

/**
 * The operation in a request body, or null (logged) when the body is not JSON
 * or not an object with an `op`. Only the worker calls this DO, so either is
 * a bug worth seeing in the logs.
 */
async function readOp(request: Request, logger: RequestLogger): Promise<PartnerKeyStoreOp | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    logger.error('partner_key_store_bad_request', error, { reason: 'invalid_json' });
    return null;
  }
  if (typeof body === 'object' && body !== null && 'op' in body) return body as PartnerKeyStoreOp;
  logger.warn('partner_key_store_bad_request', { reason: 'not_an_operation' });
  return null;
}

/**
 * Legacy-import lease (one import per key at a time): `import-lease:<key id>`.
 * A second import of the same key while one runs could delete audio the
 * first one just wrote (each run's cleanup removes what it wrote, and the
 * other run may already be reusing it). The TTL only covers a run that died
 * without releasing; a live run releases in `finally`.
 */
const IMPORT_LEASE_PREFIX = 'import-lease:';
export const IMPORT_LEASE_TTL_MS = 10 * 60 * 1000;
type ImportLease = { holder: string; expiresAt: number };

/** Request id used when the worker sent none (it always does); never random. */
const NO_REQUEST_ID = 'partner-key-store:no-request-id';
/** Request id for alarm-level events not tied to one owed key; never random. */
const ALARM_REQUEST_ID = 'partner-key-store:alarm';

export class PartnerKeyStoreDO {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const requestId = request.headers.get('X-Request-ID') ?? NO_REQUEST_ID;
    const logger = createRequestLogger(requestId);
    // Like UserDO: the DO runs in its own isolate with its own log buffer and
    // metric aggregation, so it initialises and flushes telemetry itself.
    initLogTelemetry(this.env);
    initMetricTelemetry(this.env);
    try {
      const op = await readOp(request, logger);
      if (!op) return Response.json({ error: 'Body must be a JSON operation' }, { status: 400 });
      return await this.handle(op, logger, requestId);
    } finally {
      flushLogTelemetry((promise) => this.state.waitUntil(promise));
      flushMetricTelemetry((promise) => this.state.waitUntil(promise));
    }
  }

  /**
   * Retry owed KV projections. Like UserDO.alarm: no OTLP flush here (outbound
   * fetch from an alarm is blocked; the tail worker forwards these logs) and
   * metrics are suppressed. Each key's retry is logged under the request that
   * owes it. A failure is logged and re-thrown so the runtime retries the
   * alarm; first, an alarm is kept scheduled while any projection is owed.
   */
  async alarm(): Promise<void> {
    const logger = createRequestLogger(ALARM_REQUEST_ID);
    await runWithMetricsSuppressed(async () => {
      try {
        await this.serialize(() =>
          this.ledger(logger, ALARM_REQUEST_ID, 'alarm').retryProjections(createRequestLogger)
        );
      } catch (error) {
        logger.error('partner_key_projection_alarm_failed', error);
        // Through the same chain as every operation, so the re-arm can never
        // interleave with the next admin operation's commit.
        await this.serialize(() => this.keepAlarmWhileOwed(logger));
        throw error;
      }
    });
  }

  private async handle(
    op: PartnerKeyStoreOp,
    logger: RequestLogger,
    requestId: string
  ): Promise<Response> {
    try {
      const result = await this.serialize(() => this.run(op, logger, requestId));
      return result === undefined
        ? Response.json({ error: `Unknown operation '${String(op.op)}'` }, { status: 400 })
        : Response.json(result);
    } catch (error) {
      logger.error('partner_key_store_failed', error, { op: op.op });
      return Response.json({ error: 'Partner key store operation failed' }, { status: 500 });
    }
  }

  /** After a failed alarm: make sure a retry is still scheduled while anything is owed. */
  private async keepAlarmWhileOwed(logger: RequestLogger): Promise<void> {
    try {
      const owed = await this.ledger(logger, ALARM_REQUEST_ID, 'alarm').armAlarm();
      logger.log('partner_key_projection_alarm_rearmed', { owed });
    } catch (error) {
      logger.error('partner_key_projection_alarm_rearm_failed', error);
    }
  }

  /** Run `task` after every earlier task has settled; a failure does not block later ones. */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    // Not a silent catch: this only keeps the QUEUE moving past a failed task.
    // The failure itself reaches the caller through `run`, which is returned
    // (and awaited, logged and answered by handle() / alarm()).
    this.tail = run.catch(() => undefined);
    return run;
  }

  /**
   * The ledger for one operation. A timed-out KV put that settles later is
   * logged then, so that work is kept alive with waitUntil. From fetch its
   * line is then flushed, as fetch flushes its own. From the alarm it is not:
   * the alarm's rule is no OTLP flush (outbound fetch is blocked there), and
   * the tail worker forwards alarm logs.
   */
  private ledger(
    logger: RequestLogger,
    requestId: string,
    context: 'fetch' | 'alarm' = 'fetch'
  ): PartnerKeyLedger {
    const flush = () => {
      flushLogTelemetry((promise) => this.state.waitUntil(promise));
      flushMetricTelemetry((promise) => this.state.waitUntil(promise));
    };
    return new PartnerKeyLedger({
      storage: this.state.storage,
      kv: this.env.API_KEYS,
      tagSecret: this.env.PARTNER_KEY_TAG_SECRET,
      logger,
      requestId,
      afterResponse: (work) => this.state.waitUntil(context === 'alarm' ? work : work.then(flush)),
    });
  }

  /** Take the lease unless another holder has it and it has not expired (runs serialized). */
  private async acquireImportLease(id: string, holder: string): Promise<{ acquired: boolean }> {
    const key = `${IMPORT_LEASE_PREFIX}${id}`;
    const now = Date.now();
    const lease = await this.state.storage.get<ImportLease>(key);
    if (lease !== undefined && lease.expiresAt > now) return { acquired: false };
    await this.state.storage.put(key, { holder, expiresAt: now + IMPORT_LEASE_TTL_MS });
    return { acquired: true };
  }

  /** Delete the lease only if `holder` still holds it (an expired one may have been retaken). */
  private async releaseImportLease(id: string, holder: string): Promise<{ released: boolean }> {
    const key = `${IMPORT_LEASE_PREFIX}${id}`;
    const lease = await this.state.storage.get<ImportLease>(key);
    if (lease?.holder !== holder) return { released: false };
    await this.state.storage.delete(key);
    return { released: true };
  }

  /** Dispatch one operation; undefined for an unknown op. */
  private async run(
    op: PartnerKeyStoreOp,
    logger: RequestLogger,
    requestId: string
  ): Promise<unknown> {
    const ledger = this.ledger(logger, requestId);
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
      case 'acquireImportLease':
        return this.acquireImportLease(op.id, op.holder);
      case 'releaseImportLease':
        return this.releaseImportLease(op.id, op.holder);
      default:
        return undefined;
    }
  }
}
