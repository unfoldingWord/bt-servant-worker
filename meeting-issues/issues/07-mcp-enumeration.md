---
title: MCP server resource enumeration (list tool)
labels: P1, right-diamond
---
## Problem
Producing an *exhaustive* resource list requires each MCP server to expose a list/enumeration tool. uW-owned servers can; third-party servers (FIA, etc.) only expose what their GraphQL/API allows. Aquifer MCP is reportedly ready.

## Proposed solution
A reliable, categorized listing of resources per MCP server (or a documented gap where a partner server can't provide it).

## Scope
- [ ] Audit which MCP servers expose enumeration today (start: Aquifer ready)
- [ ] Define the listing/categorization contract (consider an hourly-updated markdown manifest)
- [ ] Document requirements to share with partners building MCPs
- [ ] Track partner asks (e.g. FIA) to expose lists
