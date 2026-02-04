# MCP Integration Guidelines

This document describes the resilient integration patterns used when communicating with MCP (Model Context Protocol) servers.

## Problem Statement

A single user request can cascade into hundreds of downstream API calls:

```
1 User Request -> 7 Claude iterations -> 50 MCP calls -> 600 Door43 API calls
```

Each MCP call to `translation-helps-mcp` makes approximately 12 downstream Door43 API calls internally. Without safeguards, a runaway request could overwhelm downstream services.

## Budget Tracking

### Overview

The worker tracks cumulative downstream API calls per user request to prevent runaway resource consumption.

### Configuration

| Environment Variable               | Default | Description                                          |
| ---------------------------------- | ------- | ---------------------------------------------------- |
| `MAX_DOWNSTREAM_CALLS_PER_REQUEST` | 120     | Maximum downstream API calls allowed per request     |
| `DEFAULT_DOWNSTREAM_PER_MCP_CALL`  | 12      | Estimated downstream calls when metadata unavailable |
| `MAX_MCP_RESPONSE_SIZE_BYTES`      | 1048576 | Maximum response size (1MB)                          |

### How It Works

1. Before each MCP call, the worker checks if the budget would be exceeded
2. After each call, the worker records:
   - Actual downstream calls (if metadata provided)
   - Estimated downstream calls (if no metadata)
3. Warning logs are emitted at 75% and 90% budget utilization
4. Calls are rejected with `MCPBudgetExceededError` (HTTP 429) when budget is exhausted

### MCP Server Metadata Contract

MCP servers can optionally return metadata in their response to enable accurate budget tracking:

```json
{
  "result": { ... },
  "_meta": {
    "downstream_api_calls": 12,
    "cache_status": "miss",
    "response_size_bytes": 3600
  }
}
```

When servers don't return `_meta`, the worker falls back to the configured default estimate.

#### Metadata Fields

| Field                  | Type                               | Description                                |
| ---------------------- | ---------------------------------- | ------------------------------------------ |
| `downstream_api_calls` | number                             | Actual number of downstream API calls made |
| `cache_status`         | `"hit"` \| `"miss"` \| `"partial"` | Whether the response was cached            |
| `response_size_bytes`  | number                             | Size of the response payload               |

## Health Tracking

### Overview

The worker passively monitors MCP server health during normal operation. No extra network overhead - health is inferred from actual call results.

### Circuit Breaker

After 3 consecutive failures, a server is marked unhealthy and subsequent calls are rejected until recovery (a successful call resets the counter).

### Metrics Tracked

- Total calls per server
- Failed calls per server
- Response times (for successful calls)
- Consecutive failure count
- Last error message

### Health Summary

At the end of each orchestration, a health summary is logged:

```json
{
  "server_health": [
    {
      "server_id": "translation-helps",
      "healthy": true,
      "total_calls": 15,
      "failure_rate": 7,
      "avg_response_ms": 234
    }
  ]
}
```

## Response Size Limiting

### Overview

MCP responses are limited to prevent memory exhaustion from oversized payloads.

### How It Works

1. If the `Content-Length` header is present, it's checked before reading the body
2. Response body is streamed and accumulated with size checking
3. If size exceeds the limit, reading is aborted and `MCPResponseTooLargeError` (HTTP 413) is thrown

## Error Handling

### Error Classes

| Error                      | HTTP Status | Code                     | Description                     |
| -------------------------- | ----------- | ------------------------ | ------------------------------- |
| `MCPBudgetExceededError`   | 429         | `MCP_BUDGET_EXCEEDED`    | Downstream API budget exhausted |
| `MCPResponseTooLargeError` | 413         | `MCP_RESPONSE_TOO_LARGE` | Response exceeds size limit     |
| `MCPError`                 | 502         | `MCP_ERROR`              | General MCP communication error |

### Recovery Guidance

When `MCPBudgetExceededError` occurs:

- Suggest narrowing the request scope
- Offer to continue in batches
- Fetch summaries instead of individual items

When server is unhealthy:

- Wait for circuit breaker to reset
- Check server logs for root cause
- Consider alternative servers if available

## Logging

### Key Log Events

| Event                   | Level | Description                          |
| ----------------------- | ----- | ------------------------------------ |
| `mcp_budget_status`     | info  | Budget state after each MCP call     |
| `mcp_budget_warning`    | warn  | Budget at 75% or 90% utilization     |
| `mcp_budget_exceeded`   | warn  | Call rejected due to budget          |
| `mcp_server_unhealthy`  | warn  | Call rejected due to circuit breaker |
| `orchestration_summary` | info  | Final health and budget summary      |

## Future Improvements

### Tier 1: MCP Server Metadata (Requires Server Changes)

Request MCP servers implement the `_meta` response field for accurate budget tracking. See the metadata contract above.

### Tier 3: Active Health Pings

Implement periodic health checks to proactively detect server issues before user requests fail.

## Related Documentation

- [Implementation Plan](./implementation-plan.md)
- [MCP Protocol Specification](https://modelcontextprotocol.io/)
