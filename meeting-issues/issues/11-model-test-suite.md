---
title: Model test suite with AI cross-check
labels: P1, right-diamond
---
## Problem
No harness to compare answer quality across models - needed to support model-routing and token-reduction decisions.

## Proposed solution
Run the same battery of questions across models with AI cross-checking quality. Expose the battery to individual admin users, since answers vary per mode.

## Scope
- [ ] Build the question battery + runner across models
- [ ] AI-based answer-quality cross-check
- [ ] Expose per-admin test capability in the admin portal
