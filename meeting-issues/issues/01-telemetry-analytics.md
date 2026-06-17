---
title: Build telemetry/analytics to learn who our users are
labels: P0, right-diamond
---
## Problem
440+ distinct users growing ~20-25/day across ~25-30 countries (~33-37% return), but we can't yet tell *who* they are or *how* they use it. The current telemetry app is a one-shot surface scratch.

## Proposed solution
Robust event capture and a dashboard answering: user expertise level (novice vs. trainer), how/what they query, geography, and time-of-day peaks. Make telemetry a first-class citizen for V3 (build-measure-learn).

## Scope
- [ ] Robust event/telemetry capture
- [ ] Geo + time-of-day breakdowns (from Cloudflare data)
- [ ] Query analysis to infer use cases and BT expertise level
- [ ] Dashboard surfacing the above
