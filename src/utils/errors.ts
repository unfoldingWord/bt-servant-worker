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
