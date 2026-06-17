---
title: Rate-limit & token strategy (beyond the back-off band-aid)
labels: P1, right-diamond
---
## Problem
Back-off only buys time. Growth will worsen rate limits; we want lower cost and less Anthropic dependence.

## Proposed solution
A two-pronged plan: reduce token usage AND mitigate limits.

## Scope
- [ ] Talk to Anthropic about raising limits beyond Tier 4
- [ ] Evaluate multi-key / sharded keys (note: per-org; Anthropic may disallow - verify)
- [ ] Token-burn analysis: model selection (currently Sonnet only), thinking intensity, pre-routing by question type (Opus-low / Sonnet / Haiku)
- [ ] Assess open-source model parity for offloading
