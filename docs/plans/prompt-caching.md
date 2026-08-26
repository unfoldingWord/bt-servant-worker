# Prompt caching + token telemetry (issue #333)

## Step 0: Branch first

Do not start on `main`. This work shipped on `feat/issue-333-prompt-caching`; any follow-up
below gets its own branch off fresh `main`, its own version bump, and its own review cycle.

---

## Context

Anthropic has been emailing unfoldingWord that our prompt cache hit rate is low and that caching
"could save up to 50% of direct API spend."

The hit rate was not low. It was **zero**. `buildMessageBody()` in
`src/services/claude/orchestrator.ts` sent `system` as a plain string, and no `cache_control`
existed anywhere in the repo. Cache writes happen only at a `cache_control` breakpoint, and the
backward lookback finds _prior writes_, not "stable-looking content" — so with no breakpoint
there was nothing to write and nothing to read.

`src/services/claude/orchestrator.ts` is the **only** Anthropic call site in the repo, and no
sibling BT Servant service calls the Anthropic API in production (`translation-helps-mcp` has
references only in `clients/typescript-example` and `.cursor/mcp.json`). One function held the
entire savings opportunity.

Secondary problem, equally important: **the worker logged no token usage at all.**
`response.usage` was parsed and discarded. We could not state what we spent, so we could not
state what we saved. That is why this is a telemetry change as much as a caching change.

### What was being re-sent, measured on production (2026-08-26)

Model is `claude-sonnet-4-6` — `CLAUDE_MODEL` is unset in `wrangler.toml`, so `DEFAULT_MODEL`
applies. Sonnet 4.6 pricing: **$3.00 / MTok** base input, **$3.75** 5m cache write, **$6.00** 1h
cache write, **$0.30** cache read. Minimum cacheable prefix on this model is 1,024 tokens.

| Prefix component                                     | Source                                               |       chars |    ~tokens |
| ---------------------------------------------------- | ---------------------------------------------------- | ----------: | ---------: |
| `tools` array (11 tool defs)                         | `buildAllTools()`                                    |       7,783 |     ~2,160 |
| MCP tool catalog                                     | `generateToolCatalog()`, 31 tools / 3 servers        |       3,238 |       ~900 |
| Hardcoded system sections                            | `AUDIO_GUIDANCE`, `MEDIA_FORMATTING_RULES`, headings |      ~1,477 |       ~410 |
| org prompt-override slots (`unfoldingWord`, no mode) | `PROMPT_OVERRIDES` KV                                |      16,105 |     ~4,470 |
| **Stable prefix, default org, no mode**              |                                                      | **~28,600** | **~7,950** |

Modes replace the org slots, and the big ones are much bigger (measured after `%%`-comment
stripping):

| Active mode             | mode doc (stripped) | ~tokens | **stable prefix incl. tools + catalog** |
| ----------------------- | ------------------: | ------: | --------------------------------------: |
| _(none — org defaults)_ |              16,105 |  ~4,470 |                              **~7,950** |
| `dbs-coach`             |               5,255 |  ~1,460 |                                  ~4,900 |
| `translation-coach`     |              20,625 |  ~5,730 |                                  ~9,200 |
| `fia-drafting`          |              24,867 |  ~6,910 |                                 ~10,400 |
| `cbbt-mentoring`        |              27,872 |  ~7,740 |                                 ~11,200 |
| `spoken-mode`           |              49,734 | ~13,820 |                             **~17,300** |

`MAX_ORCHESTRATION_ITERATIONS` is **100**. Every iteration re-sent the entire stable prefix at
full price, _plus_ every tool result accumulated so far (each capped at 12 KB, whole body capped
at 200 KB ≈ 55k tokens).

---

## What shipped

One PR, this repo only. Telemetry and breakpoints together.

### 1. The system prompt is split, not reordered

`buildSystemPromptBlocks()` in `src/services/claude/system-prompt.ts` returns
`{ stable, volatile }`. `buildSystemPrompt()` keeps its old signature and is now
`blocks.stable + blocks.volatile`, so every pre-existing test asserts on exactly the string it
did before.

**No prompt text moved.** The cut lands on a seam that already existed in the assembly order:

| Section                                    | Block      | Why                                                                                 |
| ------------------------------------------ | ---------- | ----------------------------------------------------------------------------------- |
| `identity`, `methodology`, `tool_guidance` | **stable** | org/mode slots                                                                      |
| `generateToolCatalog(catalog)`             | **stable** | deterministic — `discoverAllTools` uses `Promise.all`, which preserves server order |
| `instructions`                             | **stable** | org/mode slot                                                                       |
| `buildClientSection(...)` onward           | volatile   | per-turn or per-user                                                                |

The `'\n\n'` section separator is carried as the **leading characters of `volatile`**, never
re-joined by the caller — otherwise a lost separator would pass an equality test that re-adds it.

The stable block is keyed by (org, active mode) and shared across **every user, client and
conversation** in that scope. Keeping `clientId`, the memory TOC and the speaker name in the
volatile block is what avoids the classic multi-tenant 0%-hit-rate trap.

### 2. Two cache breakpoints

`buildMessageBody()` now sends:

```ts
system: [
  { type: 'text', text: ctx.systemStable, cache_control: { type: 'ephemeral' } },
  ...(ctx.systemVolatile ? [{ type: 'text', text: ctx.systemVolatile }] : []),
],
cache_control: { type: 'ephemeral' },   // automatic rolling breakpoint
```

- **Explicit, on the stable system block.** Render order is `tools` → `system` → `messages`, so
  this single entry covers the tool definitions _and_ the org/mode prompt prefix.
- **Top-level `cache_control`** is Anthropic's _automatic caching_: the API places a breakpoint on
  the last cacheable block and advances it as the conversation grows. This is what pays for
  tool-heavy turns, where each iteration re-sends every prior tool result. Because the breakpoint
  moves **every** iteration, consecutive writes stay ~2–6 content blocks apart — well inside the
  20-block lookback window, so no midpoint anchor is needed.

Two of the four available breakpoint slots. Prompt caching is GA; no beta header, and
`anthropic-version: 2023-06-01` is unchanged.

The volatile block is omitted rather than emitted empty — empty text blocks cannot be cached and
are rejected by the API.

### 3. Token + cache telemetry

`summarizeUsage()` reduces an Anthropic `usage` block to token accounting, tolerating missing or
partial usage (telemetry must never break a turn that otherwise succeeded). It handles the
per-TTL `usage.cache_creation` breakdown (`ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`),
falling back to attributing the whole write to the 5-minute bucket when absent.

**Log fields** on the existing `claude_response` event: `input_tokens`, `output_tokens`,
`cache_creation_input_tokens`, `cache_read_input_tokens`, `billable_input_tokens`.
`claude_response` is already whitelisted in `bt-servant-telemetry`'s `log-events.ts`, and
`redact()` silently drops unrecognised _fields_ (only unknown _event names_ warn) — so this is
safe for the tail path with no cross-repo change.

**OTel counters**, labelled `model` + `mode` (and `type` for the write bucket). Zero-valued
counters are skipped — an `add(0)` costs cardinality while carrying no information.

| Metric                                          | Labels                              |
| ----------------------------------------------- | ----------------------------------- |
| `claude_input_tokens_total`                     | `model`, `mode`                     |
| `claude_output_tokens_total`                    | `model`, `mode`                     |
| `claude_cache_write_tokens_total`               | `model`, `mode`, `type` (`5m`/`1h`) |
| `claude_cache_read_tokens_total`                | `model`, `mode`                     |
| `claude_billable_input_tokens_total`            | `model`, `mode`                     |
| `orchestration_iterations` (existing histogram) | `reason`, `model`, `mode`           |

`mode` was added to `ALLOWED_LABEL_KEYS` and `MetricLabels` in
`src/services/telemetry/metrics.ts`. It belongs with `tool_name` / `server` / `model` — bounded
by _configuration_ (`MAX_MODES_PER_ORG` is 20), not by traffic — so it is deliberately **not** in
`BOUNDED_LABEL_VALUES`, which would collapse every mode to `other`. `MAX_SERIES_PER_METRIC` is
the backstop. `org` is deliberately not a dimension, matching the `chat_turns_total` precedent of
logging org but not metering it.

### 4. Cache-miss attribution

An FNV-1a fingerprint of the stable block is computed once per request and logged on
`claude_request` as `system_stable_hash` plus `system_stable_chars`. When the hit rate dips, that
hash separates "an MCP server was down so the tool catalog shrank" from "an admin edited a prompt
override in the portal". Both change the prefix; without a fingerprint both are invisible.
Non-cryptographic and synchronous on purpose — `crypto.subtle` is async and this is on the
request path.

---

## How to pull the savings number

**No pre-caching baseline is needed.** Caching does not change the prompt, so the counterfactual
is exact rather than estimated. Per call:

```
total_prompt    = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
billable_equiv  = input + 1.25×write_5m + 2.0×write_1h + 0.1×read   ← claude_billable_input_tokens_total
savings_tokens  = total_prompt − billable_equiv
savings_usd     = savings_tokens × base_rate ÷ 1e6
cache_hit_ratio = cache_read ÷ total_prompt
```

Algebraically `savings_tokens = 0.9×read − 0.25×write_5m − 1.0×write_1h`, which is why it is
model-independent and why the dollar rate is applied only at the end — there is no price table in
the request path to go stale.

**Rate:** `claude-sonnet-4-6` → **$3.00 / MTok** base input. If `CLAUDE_MODEL` is ever set, use
that model's base input rate instead; the token metrics carry a `model` label for exactly this.

**Where:** prod OpenObserve, `https://bt-servant-openobserve-prod.fly.dev/web/`. OpenObserve
splits every OTel metric into its **own stream** (see `docs/telemetry_rollout_soe.md`), so the
query sums each counter stream per time bucket and combines them. Break down by `mode` — mode
swings the cached prefix ~3.5x between `dbs-coach` and `spoken-mode`, so an undifferentiated
number is not actionable.

**Quick sanity check without OpenObserve:** the same fields are on the `claude_response` log line
in Cloudflare Workers logs (7-day retention) — reachable with the `cf-logs` skill.

---

## Verification performed

- **1,081 unit + e2e tests pass**, including 38 new ones in `tests/unit/prompt-caching.test.ts`.
- **Each new test was deliberately broken and confirmed red** before being trusted: leaking the
  client section into the stable block, dropping the separator, moving the breakpoint to the
  volatile block, removing the top-level breakpoint, corrupting the 1.25x multiplier, dropping a
  usage log field, removing the stable-prefix hash, and moving the seam one section later. Every
  one failed the suite.
- The byte-identity test alone cannot catch a lost separator (both sides come from the same
  function), which is why the separator and seam-boundary tests exist as separate assertions.
- `pnpm lint`, `pnpm check`, `pnpm architecture` clean.

**Staging acceptance signal:** send two chats within 60s as a synthetic user, then read
`claude_response` via the `cf-logs` skill. `cache_read_input_tokens` must be **0 on the very
first iteration and > 0 on every subsequent iteration and on the second chat**. That single
number is the whole proof.

---

## Follow-ups (not in this PR)

- **Recover the ~1,400 stranded stable tokens.** `client_instructions`, `memory_instructions`,
  `AUDIO_GUIDANCE`, `PTXPRINT_FLOW_GUIDANCE`, `MEDIA_FORMATTING_RULES` and `closing` never
  change, but sit _after_ per-request sections and so fall outside the cacheable prefix.
  Collecting them means physically moving instruction text earlier — the only behavior-affecting
  change in this whole effort. Worth ~$0.004/call (~$50/month at estimated volume) against a real
  chance of shifting how the model weighs those sections. Needs its own PR and a staging A/B.
  (`MEDIA_FORMATTING_RULES` is additionally conditional on `!isVoiceMessage`, so it is a
  two-variant prefix, not a stable one — it may have to stay volatile regardless.)
- **1-hour TTL.** Ship on the 5-minute default first. Once the metrics show a real cross-turn hit
  ratio, revisit: if it is below ~60%, flip the system breakpoint to `ttl: "1h"`. Write cost goes
  to 2x and break-even moves to three reads, but the whole org shares one (org, mode) prefix, so
  three requests per hour is a low bar. The ordering constraint (longer TTL must render before
  shorter) is already satisfied — the system breakpoint precedes the automatic message one.
- **Cache pre-warming** (`max_tokens: 0`) — roughly $7/day across live (org, mode) prefixes. Only
  justified if volume warrants it; let real traffic warm the cache first.
- **Cross-repo reporting** in `bt-servant-telemetry`: D1 columns for the token fields, a savings
  line in the existing 09:00 UTC Zulip digest, a KPI tile on `telemetry.btservant.ai`. This is
  what would put the number in front of the COO automatically instead of on demand.
- **Cross-turn message caching** is blocked by the sliding `max_history_llm` window (5 for
  `unfoldingWord`): from turn 6 the oldest pair drops off and the message prefix changes at
  position 0 every turn. The system/tools cache is unaffected.
- **Model choice** (`claude-sonnet-4-6` vs Sonnet 5) — orthogonal; caches are model-scoped.

---

## Known remaining misses

| Risk                                             | Effect                                                                                                                 | Handling                                                                        |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| An MCP server is transiently down                | catalog shrinks → prefix changes → cold cache until it recovers                                                        | `system_stable_hash` makes it diagnosable; self-correcting                      |
| Prompt override or mode doc edited in the portal | intentional prefix change → one cold write                                                                             | expected; the hash explains the dip                                             |
| Concurrent first requests on a cold prefix       | a cache entry is readable only once the first response _begins streaming_, so simultaneous requests all pay full price | low impact at current concurrency; do not fan out warm-ups in parallel          |
| Adding/removing a tool definition                | invalidates tools **and** system **and** messages caches                                                               | keep `buildAllTools()` deterministic; treat tool changes as a deploy-time event |
