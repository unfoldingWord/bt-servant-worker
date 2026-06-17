---
title: Ship Cloudflare logs to durable storage (stop 7-day log loss)
labels: P0, right-diamond
---
## Problem
Cloudflare retains only ~7 days of logs (60 on the $5 tier). We're losing data we need to understand users and to support the future funding pipeline.

## Proposed solution
Pipe Cloudflare logs to durable, uW-controlled storage so nothing rolls off.

## Scope
- [ ] Choose a sink (data warehouse / log store) under our control
- [ ] Pipe Cloudflare logs to it
- [ ] Confirm retention and backfill whatever we still have
