---
title: Implement exponential back-off for Anthropic rate-limit errors
labels: P0, right-diamond
---
## Problem
Users hit Anthropic rate-limit (429) errors ~16x/day and growing. All traffic funnels through one API key; we're already at Tier 4 (no higher tier).

## Proposed solution
On rate-limit, retry with exponential back-off (e.g. 20s -> 40s) so users see a delayed response rather than an error. Band-aid only - see the broader rate-limit/token strategy issue.

## Scope
- [ ] Add exponential back-off + retry on 429s
- [ ] Verify user-facing behavior (delay, no error surfaced)
