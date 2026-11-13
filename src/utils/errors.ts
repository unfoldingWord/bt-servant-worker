/**
 * Custom error classes for bt-servant-worker
 */

export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class AuthenticationError extends AppError {
  constructor(message: string = 'Authentication required') {
    super(message, 'AUTHENTICATION_ERROR', 401);
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends AppError {
  constructor(message: string = 'Access denied') {
    super(message, 'AUTHORIZATION_ERROR', 403);
    this.name = 'AuthorizationError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 400);
    this.name = 'ValidationError';
  }
}

export class MCPError extends AppError {
  constructor(
    message: string,
    public readonly serverId?: string
  ) {
    super(message, 'MCP_ERROR', 502);
    this.name = 'MCPError';
  }
}

export class CodeExecutionError extends AppError {
  constructor(
    message: string,
    public readonly lineNumber?: number
  ) {
    super(message, 'CODE_EXECUTION_ERROR', 500);
    this.name = 'CodeExecutionError';
  }
}

export class ClaudeAPIError extends AppError {
  constructor(
    message: string,
    public readonly claudeStatusCode?: number
  ) {
    super(message, 'CLAUDE_API_ERROR', 502);
    this.name = 'ClaudeAPIError';
  }
}

/**
 * Every model route in the fallback chain reported an outage (#403). The
 * message is deliberately generic: per-route diagnostics (network error text,
 * upstream bodies) go to the logs, never to the user-facing detail.
 */
export class RouteChainExhaustedError extends ClaudeAPIError {
  constructor(
    public readonly routesAttempted: readonly string[],
    public readonly lastOutage: string,
    lastStatus?: number
  ) {
    super(`All model routes failed (last: ${lastOutage})`, lastStatus);
    this.name = 'RouteChainExhaustedError';
  }
}

/**
 * Why Anthropic refused to serve because of money, not because of the request
 * (#468). Bounded enum, safe as a metric label.
 * - `spend_limit`: a spend limit the org (or a workspace) set itself; HTTP 400.
 * - `spend_cap`:   the usage tier's monthly cap; HTTP 429 with
 *                  `error.details.error_code: "enforced_spend_limit_reached"`.
 * - `billing`:     HTTP 402 `billing_error` (for example a declined card).
 */
export type UpstreamSpendKind = 'spend_limit' | 'spend_cap' | 'billing';

/**
 * The model provider stopped serving this org for spend or billing reasons
 * (#468). Every later request fails the same way until a person acts, so this
 * is never retried and never falls over to another route: `anthropic-alt`
 * bills to the same org, and OpenRouter would only move the bill (Ian,
 * 2026-11-04). The message is deliberately generic; the upstream body goes to
 * the `anthropic_spend_limit_reached` log, never to a user.
 */
export class UpstreamSpendLimitError extends AppError {
  constructor(
    public readonly kind: UpstreamSpendKind,
    public readonly upstreamStatus: number,
    public readonly route: string
  ) {
    super(
      kind === 'billing'
        ? 'Model provider refused the request for a billing reason'
        : 'Model provider spend limit reached',
      kind === 'billing' ? 'UPSTREAM_BILLING' : 'UPSTREAM_SPEND_LIMIT',
      503
    );
    this.name = 'UpstreamSpendLimitError';
  }
}

export class TimeoutError extends AppError {
  constructor(message: string = 'Operation timed out') {
    super(message, 'TIMEOUT_ERROR', 504);
    this.name = 'TimeoutError';
  }
}

export class MCPCallLimitError extends AppError {
  constructor(
    public readonly callsMade: number,
    public readonly limit: number
  ) {
    super(
      `Maximum MCP calls (${limit}) exceeded. Calls made: ${callsMade}. Refactor to fetch less data.`,
      'MCP_CALL_LIMIT_EXCEEDED',
      429
    );
    this.name = 'MCPCallLimitError';
  }
}

/**
 * Whole-request MCP fan-out cap. Distinct from MCPCallLimitError, which is
 * the per-`execute_code` sandbox cap. This one counts every MCP tool call
 * across the entire user turn — top-level Claude tool_use calls plus host
 * function calls inside any number of execute_code blocks. Splitting work
 * into multiple execute_code calls does NOT bypass it.
 */
export class MCPRequestCallLimitError extends AppError {
  constructor(
    public readonly callsMade: number,
    public readonly limit: number
  ) {
    super(
      `Per-request MCP call limit (${limit}) exceeded. ` +
        `Total calls in this user turn: ${callsMade}. ` +
        `This is the whole-request cap — splitting into multiple execute_code blocks ` +
        `will NOT bypass it. Stop tool calls and ask the user a clarifying question, ` +
        `or summarize what you have and let them direct next steps.`,
      'MCP_REQUEST_CALL_LIMIT_EXCEEDED',
      429
    );
    this.name = 'MCPRequestCallLimitError';
  }
}

export class AudioTranscriptionError extends AppError {
  constructor(message: string) {
    super(message, 'AUDIO_TRANSCRIPTION_ERROR', 400);
    this.name = 'AudioTranscriptionError';
  }
}

export class AudioSynthesisError extends AppError {
  constructor(message: string) {
    super(message, 'AUDIO_SYNTHESIS_ERROR', 502);
    this.name = 'AudioSynthesisError';
  }
}

export class MCPResponseTooLargeError extends AppError {
  constructor(
    public readonly actualSize: number,
    public readonly limit: number,
    public readonly serverId?: string
  ) {
    super(
      `MCP response too large: ${actualSize} bytes exceeds limit of ${limit} bytes${serverId ? ` (server: ${serverId})` : ''}`,
      'MCP_RESPONSE_TOO_LARGE',
      413
    );
    this.name = 'MCPResponseTooLargeError';
  }
}
