# Sequence of Events (SOE) — Production Bring-Up

Ordered, verifiable steps for bringing production fully up to date: shipping the worker,
turning production telemetry on, and confirming nothing downstream broke.

**Every step has a verification.** Do not advance on "it probably worked" — each step exists
to prove the previous one. Where a step can fail silently, the verification is the only thing
that will tell you.

Companion documents:

- [`docs/plans/production-otel.md`](./plans/production-otel.md) — the OTel bring-up plan (phases A1 → C4)
- Issue #341 — B3 runbook (steps 1–5 complete as of 2026-08-05)

---

## Status at time of writing (2026-08-05)

| Component                            | State                                                                 |
| ------------------------------------ | --------------------------------------------------------------------- |
| `bt-servant-openobserve-prod`        | ✅ live on R2, volume snapshotted, root login working                 |
| `bt-servant-otel-collector-prod`     | ✅ live, 2 machines, 401 on unauthenticated `POST /v1/traces`         |
| Prod smoke span                      | ✅ sent and found in the prod `traces` stream                         |
| **Prod worker**                      | ⛔ **`2.29.0`** — 26 commits behind; has **no telemetry code at all** |
| Prod worker OTLP secrets             | ❌ absent — telemetry OFF                                             |
| `bt-servant-telemetry-production`    | ✅ live and ingesting (D1 dashboard, separate from OTel)              |
| Staging OpenObserve stream retention | ❌ still 3650 days                                                    |

**The blocker:** `src/services/telemetry/` does not exist at tag `v2.29.0`. Setting the OTLP
secrets on the prod worker today would be a **silent no-op** — the secrets would store fine
and nothing would read them.

---

## Two independent telemetry systems — do not confuse them

This is the single most important thing to hold in your head while working through this SOE.

```
                    ┌──────────────────────────────────────────┐
                    │           prod worker (2.29.0)           │
                    └──────────────┬───────────────┬───────────┘
                                   │               │
              tail_consumers ──────┘               └────── OTLP export
                                   │                       (NOT YET — needs 2.37.0)
                                   ▼                              │
              ┌────────────────────────────────┐                  ▼
              │ bt-servant-telemetry-production│      ┌───────────────────────┐
              │  Tail Worker → D1 → dashboard  │      │ collector → OpenObserve│
              │  telemetry.btservant.ai        │      │  (traces/logs/metrics) │
              └────────────────────────────────┘      └───────────────────────┘
                     ALREADY LIVE — must not break         NEW — being turned on
```

|           | **bt-servant-telemetry** (D1)                 | **OTel stack** (OpenObserve)           |
| --------- | --------------------------------------------- | -------------------------------------- |
| Transport | Cloudflare Tail Worker                        | OTLP/HTTP export from worker code      |
| Storage   | D1                                            | OpenObserve on Fly + R2                |
| Hashing   | its own `PII_HASH_SALT`                       | worker's `TELEMETRY_USER_ID_SALT` (A1) |
| Status    | **already in production**                     | being enabled by this SOE              |
| Risk here | **regression** — a worker deploy can break it | net-new — nothing to break yet         |

The two salts are deliberately unrelated and the systems never meet. But **both are fed by
the same worker**, which is why deploying the worker is the moment `bt-servant-telemetry`
can break.

---

## Phase 0 — Decide the MCP question

Staging and production intentionally run **different** Translation Helps MCP endpoints, and
each environment's prompt overrides name the tools its own server exposes:

|                       | staging                                                        | production                                                                                            |
| --------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Translation Helps URL | `https://tc-helps.mcp.servant.bible/v2/mcp`                    | `https://tc-helps.mcp.servant.bible/api/mcp`                                                          |
| server version        | `2.0.0`                                                        | `7.5.0`                                                                                               |
| tools                 | `get_passage`, `get_note`, `get_questions`, `get_word_article` | `fetch_scripture`, `fetch_translation_notes`, `fetch_translation_questions`, `fetch_translation_word` |
| extra servers         | `ptxprint-mcp`, `yaapi.bible`                                  | —                                                                                                     |

> **Do NOT copy staging's `tool_guidance` / `instructions` prompt overrides into production.**
> Both environments are already internally consistent. Copying staging's slots into prod would
> instruct the model to call `get_passage` against a server that only exposes
> `fetch_scripture` — breaking the exact path the translation-helps work was meant to fix.

**Decision:** does production stay on `/api/mcp`?

- **Yes (default)** — Phase 7 does not exist. Nothing about KV or prompt overrides changes.
- **No** — Phase 7 applies, and the URL change and prompt-slot change must land together.

---

## Phase 1 — Baseline capture (do this BEFORE deploying anything)

You cannot prove you didn't break something without a "before" reading.

### 1.1 Record the prod telemetry baseline

```bash
curl -s https://telemetry.btservant.ai/api/snapshot | tee /tmp/soe-telemetry-before.json | jq .
```

Write down `distinct_users_all_time`, `login_count`, and `error_rate_1h_pct`.
Reference values on 2026-08-05: `884`, `2593`, `0`.

> Note: the **production** dashboard does not expose `chat_latency_n` (staging does). Use
> `login_count` and the `chat_total_ms_p50` field turning non-null as the increment signals.

### 1.2 Record current versions

```bash
curl -s https://bt-servant-worker.unfoldingword.workers.dev/health   # expect 2.29.0
curl -s https://bt-servant-worker-staging.unfoldingword.workers.dev/health   # expect 2.37.0
```

### 1.3 Snapshot the prod prompt overrides (rollback insurance)

```bash
curl -s -H "Authorization: Bearer $PROD_ENGINE_KEY" \
  https://api.btservant.ai/api/v1/admin/orgs/unfoldingWord/prompt-overrides \
  > /tmp/soe-prompt-overrides-before.json
```

Nothing in this SOE modifies them, which is exactly why a snapshot is cheap insurance.

### 1.4 Confirm the pseudonym salt exists on prod

```bash
wrangler secret list --env production   # expect TELEMETRY_USER_ID_SALT present
```

Without it, A1 **fails closed**: no `user_hash` egresses at all.

---

## Phase 2 — Ship the worker (2.29.0 → 2.37.0)

26 commits. Beyond telemetry it includes the aggregated resources endpoint (#257), two MCP
fixes (#322, #326), the silent-error-path work (#318), and several dependency overrides.

`Deploy` is `workflow_dispatch`-only and ships **both** the tail worker and the main worker.

### 2.1 Verify the tail consumers are intact in config

```bash
grep -A4 'tail_consumers' wrangler.toml
```

Production must list **both** `bt-servant-tail` and `bt-servant-telemetry-production`. If the
second is missing, **stop** — deploying would silently disconnect the D1 dashboard.

### 2.2 Dispatch

```bash
gh workflow run deploy.yml --ref main -R unfoldingWord/bt-servant-worker
gh run watch <run-id> -R unfoldingWord/bt-servant-worker --exit-status
```

### 2.3 Verify the version flipped

```bash
curl -s https://bt-servant-worker.unfoldingword.workers.dev/health   # expect 2.37.0
```

**Telemetry is still OFF at this point** — `isTelemetryEnabled()` requires both OTLP secrets
and prod has neither. This phase is a pure code change, judgeable on its own.

**Rollback:** re-dispatch `Deploy` from tag `v2.29.0`.

---

## Phase 3 — Prove `bt-servant-telemetry` still works ⚠️

**This is the regression check.** The D1 dashboard has been in production for months and is
fed by the worker's tail stream. A worker deploy can break it silently: the dashboard keeps
serving, the numbers just stop moving — or worse, start double-counting people.

### 3.1 Confirm the tail consumer survived the deploy

```bash
npx wrangler deployments list --name bt-servant-worker 2>/dev/null | head
curl -s https://telemetry.btservant.ai/api/snapshot | jq .generated_at_ts
```

The dashboard must still respond. A non-200 here is an immediate stop.

### 3.2 Drive one real request through production

Send a chat as a user who **already existed before the deploy** — this is what makes the
hash-continuity assertion meaningful.

> **Check whose ID it is before sending.** The request appends to that person's Durable Object
> conversation history. Real phone numbers are real people; synthetic IDs
> (`claude-e2e-verify-*`) are safe.

### 3.3 Poll until the counters move (ingestion lags ~30s)

```bash
for i in $(seq 1 12); do
  curl -s https://telemetry.btservant.ai/api/snapshot | jq -c \
    '{distinct_users_all_time, login_count, chat_total_ms_p50, error_rate_1h_pct}'
  sleep 10
done
```

### 3.4 Assert — this is the whole point of the phase

| Signal                               | Expected                  | If violated                                                                                                                                                |
| ------------------------------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dashboard responds 200               | always                    | tail consumer or worker broken — **rollback**                                                                                                              |
| `chat_total_ms_p50` becomes non-null | yes                       | logs not arriving / shape changed — **rollback**                                                                                                           |
| `distinct_users_all_time`            | **HOLDS** (884 → 884)     | ⚠️ **hash discontinuity** — the same human is being counted as a new user. The field the telemetry app hashes changed shape. **Rollback and investigate.** |
| `login_count`                        | increments (new user-day) | ingestion stalled                                                                                                                                          |
| `error_rate_1h_pct`                  | does not spike            | new code erroring                                                                                                                                          |

`distinct_users_all_time` climbing for a **returning** user is the highest-signal failure in
this SOE. It means user identity broke, every historical comparison is now invalid, and the
damage compounds with every request until it is fixed.

**Do not proceed to Phase 4 until Phase 3 passes.** Turning on OTel telemetry while the D1
pipeline is broken makes it far harder to tell which system caused what.

---

## Phase 4 — Turn production OTel telemetry ON (issue #341 step 6)

**This is the switch.** Nothing before it sends production data to OpenObserve.

```bash
wrangler secret put OTEL_EXPORTER_OTLP_ENDPOINT --env production
#   value: https://bt-servant-otel-collector-prod.fly.dev

wrangler secret put OTEL_COLLECTOR_TOKEN --env production
#   value: the collector's OTEL_INGEST_TOKEN — must match EXACTLY or every export 401s
```

The token was generated during B3 and saved to `~/Downloads/otel-ingest-token-prod.txt`. If it
is lost: generate a new one, set it on `bt-servant-otel-collector-prod` as `OTEL_INGEST_TOKEN`,
and set the same value here — they only have to match each other.

**Rollback:** unset either secret. `isTelemetryEnabled()` gates on both, and the disabled path
makes no network call at all.

---

## Phase 5 — Verify privacy on real traffic (issue #341 step 7)

Watch one full traffic cycle in the prod OpenObserve UI
(`https://bt-servant-openobserve-prod.fly.dev/web/`) and confirm on arriving records:

- `user_hash` is **present**
- `user_id` is **absent**

Two independent guarantees back this: A1 hashes at the worker, and the collector **deletes**
`user_id` on every pipeline. A raw `user_id` appearing means both failed — **unset the secrets
immediately**, this is a privacy regression rather than a cosmetic bug.

> Do not search OpenObserve for a `user_id` you sent — the collector deletes it, so a search
> returning nothing proves the redaction worked, not that ingestion failed.

---

## Phase 6 — Set stream retention (issue #341 step 8)

Last, because streams must exist before they can be configured — production's are created by
first ingest.

| Instance    | Stream                      | Set to |
| ----------- | --------------------------- | ------ |
| production  | `traces`                    | 14d    |
| production  | `logs`                      | 30d    |
| production  | `metrics`                   | 395d   |
| **staging** | `traces`, `logs`, `metrics` | **7d** |

**Staging is not optional and does not depend on any other phase.** Its streams report 3650
days today and always will: `ZO_COMPACT_DATA_RETENTION_DAYS` is a **fallback, not a ceiling** —
the compactor prefers a stream's own `stream_settings.data_retention` whenever it is > 0 and
never takes the minimum.

Read every stream back afterwards (`infra/openobserve/README.md` → Retention). Anything still
showing 3650 did not take.

---

## Phase 7 — MCP endpoint migration (ONLY if Phase 0 decided to migrate)

These must land **together** — either alone breaks production.

1. `GET` prod's current overrides and save as rollback (Phase 1.3 already did this)
2. `PUT` **only** `tool_guidance` and `instructions` — single-slot PUT, never the whole object
3. Update the Translation Helps server URL to `/v2/mcp`
4. Re-`GET` and verify `client_instructions` and `memory_instructions` are **byte-identical**
   to the snapshot
5. Decide separately whether `ptxprint-mcp` and `yaapi.bible` should exist in production

> **Why single-slot PUT is mandatory:** production carries content staging does not — a
> `## v2 Rollout` block in `client_instructions` and an "already alerted about v1→v2" line in
> `memory_instructions`. The PUT handler merges per slot (`mergePromptOverrides`), so sending
> the whole object would wipe prod-only content that exists nowhere in git.

**Rollback:** re-PUT the saved slots and restore the URL. Instant, no deploy required.

---

## Rollback summary

| Phase                | Rollback                                    | Speed            |
| -------------------- | ------------------------------------------- | ---------------- |
| 2 — worker deploy    | re-dispatch `Deploy` from tag `v2.29.0`     | one workflow run |
| 4 — telemetry switch | `wrangler secret delete` either OTLP secret | seconds          |
| 6 — retention        | re-set the stream's retention value         | seconds          |
| 7 — MCP migration    | re-PUT saved slots + restore URL            | seconds          |

---

## Appendix — reference values

| Thing                    | Value                                                                            |
| ------------------------ | -------------------------------------------------------------------------------- |
| prod worker health       | `https://bt-servant-worker.unfoldingword.workers.dev/health`                     |
| staging worker health    | `https://bt-servant-worker-staging.unfoldingword.workers.dev/health`             |
| prod API (custom domain) | `https://api.btservant.ai`                                                       |
| staging API              | `https://staging-api.btservant.ai`                                               |
| prod D1 dashboard        | `https://telemetry.btservant.ai`                                                 |
| staging D1 dashboard     | `https://staging-telemetry.btservant.ai`                                         |
| prod OpenObserve         | `https://bt-servant-openobserve-prod.fly.dev/web/`                               |
| prod collector           | `https://bt-servant-otel-collector-prod.fly.dev`                                 |
| prod collector app       | `bt-servant-otel-collector-prod` (2 machines, iad)                               |
| prod OpenObserve app     | `bt-servant-openobserve-prod` (`shared-cpu-2x`/4 GB, vol `vol_vgn1090qmw68wy14`) |
| prod Fly deploy tokens   | on the `production` GitHub environment; expire ~2027-08-03                       |
| staging collector token  | expires ~2027-07-29                                                              |

**Note on `*.bt-servant.org`:** that domain does not resolve. The live domain is
`btservant.ai`.
