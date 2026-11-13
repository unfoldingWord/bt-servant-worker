/**
 * Spend and billing classifier (#468). Bodies are the documented shapes
 * (platform.claude.com/docs/en/api/rate-limits, /errors) plus the exact message
 * production logged on 2026-10-30.
 */
import { describe, it, expect } from 'vitest';
import { classifyUpstreamSpend } from '../../src/services/claude/spend-limit.js';

const body = (type: string, message: string, details?: Record<string, string>): string =>
  JSON.stringify({
    type: 'error',
    error: { type, message, ...(details ? { details } : {}) },
    request_id: 'req_test',
  });

const PROD_2026_10_30 =
  'You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.';

describe('classifyUpstreamSpend — matches (self-set limit)', () => {
  it('the production 400 from the 2026-10-29 outage is a spend_limit', () => {
    const v = classifyUpstreamSpend(400, body('invalid_request_error', PROD_2026_10_30), false);
    expect(v).toMatchObject({
      kind: 'spend_limit',
      errorType: 'invalid_request_error',
      message: PROD_2026_10_30,
      bodyJson: true,
    });
  });

  it('the workspace variant is a spend_limit', () => {
    const msg =
      'You have reached your specified workspace API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.';
    expect(classifyUpstreamSpend(400, body('invalid_request_error', msg), false)?.kind).toBe(
      'spend_limit'
    );
  });

  it('tolerates case, spacing and singular "limit"', () => {
    const msg = 'you have  REACHED your specified\nAPI usage limit.';
    expect(classifyUpstreamSpend(400, body('invalid_request_error', msg), false)?.kind).toBe(
      'spend_limit'
    );
  });

  it('a reworded message that still says "usage limit" and "regain access" matches', () => {
    const msg = 'Your organization is over its usage limit. Regain access on 2027-01-01.';
    expect(classifyUpstreamSpend(400, body('invalid_request_error', msg), false)?.kind).toBe(
      'spend_limit'
    );
  });

  it('a non-JSON 400 body is matched on the raw text', () => {
    const v = classifyUpstreamSpend(400, PROD_2026_10_30, false);
    expect(v).toMatchObject({ kind: 'spend_limit', bodyJson: false });
  });
});

describe('classifyUpstreamSpend — matches (spend cap, billing)', () => {
  it('the tier spend-cap 429 is recognised by its error_code', () => {
    const v = classifyUpstreamSpend(
      429,
      body('rate_limit_error', 'anything at all', { error_code: 'enforced_spend_limit_reached' }),
      false
    );
    expect(v).toMatchObject({ kind: 'spend_cap', errorCode: 'enforced_spend_limit_reached' });
  });

  it('the documented tier-cap message without the code is still a spend_cap (no retry-after)', () => {
    const msg =
      "You have reached your API usage limits: your organization has crossed its monthly API usage threshold, set based on your organization's API tier. You will regain access on 2026-09-01 at 00:00 UTC.";
    expect(classifyUpstreamSpend(429, body('rate_limit_error', msg), false)?.kind).toBe(
      'spend_cap'
    );
  });

  it('the error_code on a 400 is a spend_limit', () => {
    const v = classifyUpstreamSpend(
      400,
      body('invalid_request_error', 'x', { error_code: 'enforced_spend_limit_reached' }),
      false
    );
    expect(v?.kind).toBe('spend_limit');
  });

  it('a 402 is billing, whatever the body', () => {
    expect(classifyUpstreamSpend(402, '', false)?.kind).toBe('billing');
    expect(
      classifyUpstreamSpend(402, body('billing_error', 'Your credit card was declined'), false)
        ?.kind
    ).toBe('billing');
  });

  it('a billing_error type on another status is billing', () => {
    expect(classifyUpstreamSpend(400, body('billing_error', 'Payment required'), false)?.kind).toBe(
      'billing'
    );
  });

  it('trims the logged message to 300 characters', () => {
    const long = `${PROD_2026_10_30} ${'x'.repeat(500)}`;
    expect(
      classifyUpstreamSpend(400, body('invalid_request_error', long), false)?.message
    ).toHaveLength(300);
  });
});

describe('classifyUpstreamSpend — does not match (400s)', () => {
  it.each([
    ['prompt too long', 'prompt is too long: 210000 tokens > 200000 maximum'],
    ['empty user turn', 'messages.3: user messages must have non-empty content'],
    ['max_tokens', 'max_tokens: 64001 > 64000, which is the maximum allowed'],
    ['prefill', 'This model does not support assistant message prefill.'],
  ])('a validation 400 (%s)', (_name, msg) => {
    expect(classifyUpstreamSpend(400, body('invalid_request_error', msg), false)).toBeNull();
  });
});

describe('classifyUpstreamSpend — does not match (429s, other statuses)', () => {
  it('an ordinary 429 rate limit', () => {
    const msg =
      'This request would exceed the rate limit for your organization of 2,000,000 input tokens per minute.';
    expect(classifyUpstreamSpend(429, body('rate_limit_error', msg), true)).toBeNull();
    expect(classifyUpstreamSpend(429, body('rate_limit_error', msg), false)).toBeNull();
  });

  it('a ramp-limit 429', () => {
    expect(
      classifyUpstreamSpend(
        429,
        body('rate_limit_error', 'ramp', { error_code: 'ramp_limit_exceeded' }),
        true
      )
    ).toBeNull();
  });

  it('a 429 whose message says usage limit but carries retry-after (Claude Code workspace limit)', () => {
    const msg = 'You have reached your specified workspace API usage limits.';
    expect(classifyUpstreamSpend(429, body('rate_limit_error', msg), true)).toBeNull();
  });

  it.each([401, 403, 404, 413, 500, 529])('status %i, even with spend text', (status) => {
    expect(
      classifyUpstreamSpend(status, body('invalid_request_error', PROD_2026_10_30), false)
    ).toBeNull();
  });

  it('a 400 whose JSON has no error object and no spend text', () => {
    expect(classifyUpstreamSpend(400, '{"ok":false}', false)).toBeNull();
    expect(classifyUpstreamSpend(400, 'null', false)).toBeNull();
  });
});
