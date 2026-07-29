# Production OTel bring-up + telemetry cutover

## Step 0: Branch first

Do not start on `main` or on an unrelated branch. Every PR below gets its own branch off
fresh `main`, its own version bump, and its own review cycle.

---

## Order of operations

```
  A1  worker: pseudonymize user_id on the OTLP path ONLY
   │   (console bytes unchanged — bt-servant-telemetry untouched)
   │
   ├──────────────────────────────┬───────────────────────────────┐
   ▼                              ▼                               │
  B1  ENVIRONMENT fix +          C1  bt-servant-telemetry:        │
      collector params + CI/CD       OTLP receive route            │
   ▼                                 (alongside tail handler)      │
  B2  prod OpenObserve +             ▼                             │
      prod collector config      C2  staging collector → exporter  │
   ▼                                 DUAL-WRITE on staging         │
  B3  provision + secrets            verify vs -dev D1             │
      PROD TELEMETRY LIVE ──────────►▼                             │
                                 C3  prod collector → exporter     │
                                     DUAL-WRITE on prod            │
                                     verify vs -production D1      │
                                     ▼                             │
                                 C4  remove tail_consumers ◄───────┘
                                     + delete tail handler
```

**Linear, if you want one list:** A1 → (B1 → B2 → B3) and (C1 → C2) in parallel → C3 → C4.

**The one dependency people trip on:** C3 requires B3. The production telemetry app can only
be fed by OTLP once the _production_ worker is exporting OTLP, and that is what B3 turns on.
C2 has no such constraint — staging OTLP already exists today, so the entire cutover can be
proven on staging while Phase B is still in flight.

---

## Context

Today there is **one** collector (`bt-servant-otel-collector`) and **one** OpenObserve
(`bt-servant-openobserve`), both on fly, both effectively staging-only: the production
worker has no `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_COLLECTOR_TOKEN` secrets, so
`isTelemetryEnabled()` (`src/services/telemetry/config.ts:32`) returns false and the whole
path is a no-op. **Production telemetry does not exist yet.**

Separately, `bt-servant-telemetry` (the handrolled cohort dashboard at
`telemetry.btservant.ai`) ingests via Tail Worker off `console.log`, and is live and
depended upon. Phase C moves it onto the OTel pipe without ever putting it at risk.

### Decisions (settled)

- **Separate prod OpenObserve + prod collector.** The live instance reports
  `rbac_enabled: false` (OSS build, confirmed via its public `/config`). With no per-stream
  scoping available, a shared sink would give every OO login — the infra admin account, and
  anyone we later give QA — read access to production data, with no way to scope it down
  later without Enterprise. Instance separation is the only access control we have.
- **Pseudonymization blocks prod telemetry** (A1 before B3).
- **The two salts are independent.** The worker gets a fresh `TELEMETRY_USER_ID_SALT` for the
  OpenObserve path; `bt-servant-telemetry` keeps using its existing, unreadable
  `PII_HASH_SALT` for D1. Nothing needs to be retrieved, matched, or rotated.
- **R2 object storage for the prod OO from day one.** Greenfield, so no migration.
- **Nothing may change what `console.log` emits** until Phase C is complete. That is the
  hard safety constraint; see A1.

---

# Phase A — Pseudonymize `user_id` on the OTLP path

## A1 — worker code **[blocks B3; should precede C1]**

Today the worker egresses `user_id` **raw** (allow-listed at
`src/services/telemetry/redact.ts:40`) and the collector applies an unsalted `action: hash`.
Telegram/WhatsApp ids sit in an enumerable space, so an unsalted digest is a lookup table
away from reversal — strictly weaker than the salted HMAC `bt-servant-telemetry` already
uses.

### The safety constraint

`src/utils/logger.ts` builds **one** `LogEntry` consumed by two branches:

```
log(entry):51-54
  ├─ 1. console.log(JSON.stringify(entry))   ← serialized HERE, first
  └─ 2. logSink?.('info', entry)             ← OTLP branch, runs after
```

`bt-servant-telemetry` eats branch 1 and derives its own hash from `obj.user_id`
(`../bt-servant-telemetry/apps/web/src/ingest/redact.ts:78-79`). **Any change to `LogEntry`
itself hits both branches and corrupts the cohort tables** — renaming the field nulls every
`user_hash`; reusing the field name double-hashes and resets every cohort to zero. Both
fail silently.

### The change

Emit **both** identifiers on the OTLP branch and let the collector deliver the right one to
each destination. The work lands in `buildLogAttributes()`
(`src/services/telemetry/logs.ts:84`), which builds a brand-new object and runs after
`console.log` has already serialized. The console branch is therefore untouched _by
construction_, not by convention.

### The two salts are independent — do NOT share them

|            | salt                           | computed by            | lands in    | consumed by     |
| ---------- | ------------------------------ | ---------------------- | ----------- | --------------- |
| **hash A** | `PII_HASH_SALT` (existing)     | `bt-servant-telemetry` | D1          | cohort KPIs     |
| **hash B** | `TELEMETRY_USER_ID_SALT` (new) | the worker             | OpenObserve | ops correlation |

`PII_HASH_SALT` is a write-only wrangler secret that cannot be read back — and does not need
to be. `bt-servant-telemetry` keeps _using_ it without anyone reading it, so it keeps
producing the exact hash A it always has. The worker's salt is unrelated and freshly
generated. See "Why two hashes cannot double-count" at the end of Phase C.

### Changes

- **New secret `TELEMETRY_USER_ID_SALT`, per env, freshly generated** (`openssl rand -hex 32`).
  No relationship to `PII_HASH_SALT` and no coordination with the other repo.
- Compute `user_hash = HMAC-SHA-256(TELEMETRY_USER_ID_SALT, "${client_id}:${user_id}")`.
- **Hash once per request, at the entry point**, and stash it in `AsyncLocalStorage`.
  `crypto.subtle.sign` is async; `buildLogAttributes` is sync. This pattern already exists
  here — `metrics.ts:426` uses ALS for `metricSuppression`, and `logs.ts:31` notes
  otel-cf-workers installs the global ALS context manager.
- In `buildLogAttributes`, emit `user_hash` **alongside** `user_id`. Both stay in
  `SAFE_STRING_ATTRIBUTE_KEYS`; the collector strips whichever is wrong per destination
  (B1 and C2).
- In `redactSpan()`, **substitute** rather than emit both — spans go only to OpenObserve, so
  a raw id there has no consumer and should not exist.
- **Fail closed outside ALS scope.** No pseudonym in context (startup, an unwrapped alarm
  handler) ⇒ omit `user_hash`. A missing correlation key is recoverable; a leaked raw id is
  not.
- **The OTLP branch must never mutate `entry`.** It currently doesn't. Make it a test.

### Verification — four layers, not confidence

1. **Golden-output test.** Snapshot the exact `console.log` JSON for a representative set of
   events; assert byte-identical before and after. Fails loudly if the console shape ever
   drifts, including from unrelated future PRs.
2. **Consumer contract test.** Run the handrolled `redact()` against before/after log lines
   and assert an identical `CleanEvent` — same `user_hash`, same everything. (It reads
   `obj.user_id`, which A1 leaves in place, so this should pass trivially. Assert it anyway:
   it is the regression gate for anyone who later "cleans up" the duplicate identifier.)
3. **No-mutation test.** Deep-freeze the `LogEntry`, run `emitLog`, assert no throw.
4. **Staging bake on live traffic.** Staging feeds a separate instance of the consumer,
   `bt-servant-telemetry-dev`, backed by its own D1 (`wrangler.toml:98-100`). Deploy to
   staging only; confirm row counts keep growing and sampled `user_hash` values are
   unchanged. Production is never involved.

### Caveat to record

This is pseudonymization, not anonymization. Stable pseudonyms remain personal data,
re-identifiable by linkage. It reduces blast radius; it does not retire the need for a
retention and deletion policy.

Rotation asymmetry worth knowing: **hash A's salt can never be rotated** without destroying
cohort continuity (that repo's `implementation-plan.md:232` treats it as a one-way migration
value). **Hash B's salt can be rotated freely** — it only affects the ability to correlate
one OpenObserve record to another within the retention window, and nothing is computed
cumulatively from it. If we ever suspect a leak, rotating the worker's salt is cheap.

---

# Phase B — Production OTel bring-up

## B1 — prod `ENVIRONMENT` + collector parameterization + CI/CD ✅ SHIPPED

**Shipped 2026-07-29** — PR #339, merged as `1ed38ef`, tagged `v2.35.2`. Closed #324 item 1.
The collector deploy ran for real on merge: machines v3→v4, both `Everything is ready`, no
exporter errors, and the staged `INFLUX_BUCKET` applied.

**Three things B1 established that B2/B3 depend on — do not re-derive or undo:**

1. **The deploy jobs' `environment: staging` / `environment: production` declarations are
   load-bearing.** GitHub resolves environment-scoped secrets over repo-level ones, so the
   prod job can pick up a _different_ `FLY_API_TOKEN` value under the same name with **no
   workflow edit**. That is how two narrowly-scoped tokens serve one workflow. Do not remove
   those lines, and do not consolidate onto one org-wide token — a CI leak would then reach
   every app in the org.
2. **`FLY_API_TOKEN` is app-scoped to `bt-servant-otel-collector` only** (verified: it cannot
   see other apps in the org). **It cannot deploy the prod collector** — B3 mints its own.
   It **expires ~2027-07-29**; collector deploys go red when it lapses.
3. **Three deliberate version pins** — collector image (`Dockerfile ARG OTELCOL_VERSION`),
   `setup-flyctl` action commit SHA, and the `flyctl` CLI version (the action's `version:`
   input, whose default is `latest`). Pinning the action alone still installs an unreviewed
   binary that receives the deploy token. See the table in `infra/otel-collector/README.md`.

Also note `.github/scripts/assert-collector-invariants.py` **fails if `debug` is wired into
any pipeline** — intentional, and relevant to B3 step 4, which temporarily wires it.

- **`wrangler.toml:35`: `ENVIRONMENT = "development"` → `"production"`.** Prod deploys run
  with no `--env` flag (`.github/workflows/deploy.yml:36`), so the top-level `[vars]` block
  _is_ the production config — prod telemetry would otherwise arrive tagged
  `namespace: development`. The only consumers are three `service.namespace` sites
  (`config.ts:190`, `logs.ts:272`, `metrics.ts:510`), so there is no behavioral risk outside
  telemetry. `wrangler dev` will report `production`, which is harmless: telemetry is a
  no-op locally without the secrets.
- Parameterize the env-specific collector value — `bucket: bt-servant-staging` is hardcoded
  → `${env:INFLUX_BUCKET}`. `O2_ENDPOINT` / `O2_AUTH` / `OTEL_INGEST_TOKEN` are already
  env-driven. One config file, two apps, different secrets.
- **Replace the `attributes/redact` `user_id: hash` action with `user_id: delete`.** After A1
  the worker sends a properly salted `user_hash`, so the collector's unsalted digest is
  redundant; deleting the raw id is what keeps it out of OpenObserve. Until C2 there is only
  one logs pipeline, so a single `delete` covers it.
- **Remove the `debug` exporter from all three pipelines.** The config's own comment says to
  once the sink is confirmed; `verbosity: detailed` is expensive under real traffic.
- New GitHub Actions workflow: deploy the collector on pushes to `main` touching
  `infra/otel-collector/**`, via `flyctl deploy --remote-only` with a `FLY_API_TOKEN` repo
  secret. `otelcol validate` as a pre-deploy gate — the M0 crash-loop lesson. Deploys both
  the staging and prod collector apps.

## B2 — prod OpenObserve + prod collector config → **issue #340**

- `infra/openobserve/fly.prod.toml`:
  - **Machine:** staging runs `shared-cpu-1x` / 1 GB. Size CPU and RAM first — for
    full-history scans those bind before disk does.
  - **Storage:** R2 via `ZO_S3_*` (same Cloudflare account, zero egress). Keep a small local
    volume for WAL/cache; it stops being the retention boundary.
  - **Retention tiering.** Staging currently reports `data_retention_days: 3650` — ten
    years, which is nobody's intent. Set per-stream: traces ~14d, logs ~30d, metrics ~13mo
    (bounded-label, so tiny).
- `infra/otel-collector/fly.prod.toml` (or an `--app` override in the B1 workflow).
- Update `infra/README.md` and both `infra/*/README.md` for the two-environment topology.
- **Move `INFLUX_BUCKET` out of fly secrets into `[env]` in each app's `fly.toml`.** Surfaced
  during B1: it is a bucket _name_, not a secret, and as a fly secret it is the single value
  distinguishing the two environments while being invisible and unreviewable (`fly secrets
list` shows only a digest). In `fly.toml [env]` the bucket↔environment mapping lives in git
  and is code-reviewed; only the door43 _token_ needs to stay secret. If done, teach
  `assert-collector-invariants.py` to assert each `fly.toml`'s bucket matches its app, and
  drop `INFLUX_BUCKET` from `check-collector-secrets.sh`'s required list.

## B3 — provision + enable **[no code; runbook]** → **issue #341**

Ordered, because each step proves the previous one.

1. Provision the prod fly apps, the R2 bucket, and its access key.
2. Create the prod OpenObserve root user. **Save the password before setting it** — fly
   secrets are write-only, and v0.91 enforces ≥8 chars with upper + lower + digit + special
   (a non-compliant value crash-loops the app on boot).
3. door43: point the prod collector at the **`bt-servant`** bucket (PR #329 smoke-tested
   both token↔bucket pairs). It auto-creates with infinite retention — ask infra to set a
   retention period after first write.
4. Deploy the prod collector with `debug`-only exporters; confirm bearer auth end to end.
5. Add the OpenObserve exporters; confirm records land in the prod UI.
6. `wrangler secret put OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_COLLECTOR_TOKEN` on the prod
   worker. **This is the switch.** Telemetry starts flowing here and nowhere earlier.
7. Watch one full traffic cycle before removing `debug`.

**Credentials for B3** (see B1's carry-forward notes above for why):

- Mint a **new app-scoped** deploy token: `flyctl tokens create deploy --app <prod-collector>`.
  The existing `FLY_API_TOKEN` cannot deploy prod.
- Store it as `FLY_API_TOKEN` **on the `production` GitHub environment**, not at repo level.
- Verify it can run `flyctl secrets list` (the pre-flight depends on it) and **cannot** see the
  staging app.
- Set the **`FLY_PROD_COLLECTOR_APP`** repo variable — this is what un-skips the prod deploy
  job. It stays skipped until then, by design.
- Give the prod app all five secrets, with `INFLUX_BUCKET=bt-servant` (not the staging bucket)
  paired with a matching door43 token — their Nginx validates the two against each other.
- Prefer `fly secrets set --stage` so secrets apply on the next deploy instead of restarting a
  live pipe. Staged secrets still appear in `flyctl secrets list --json`, so the pre-flight
  passes.

**Rollback** is unsetting either worker secret: `isTelemetryEnabled()` gates on both
(`config.ts:32`), and the disabled path makes no network call at all.

---

# Phase C — Cut `bt-servant-telemetry` over to OTel

## Why this is safe: there is no cutover moment

Every D1 write in `ingest/upsert.ts` is idempotent:

- `events` — `INSERT OR IGNORE` on PK `(request_id, event, ts)`
- `user_active_days` — `INSERT OR IGNORE` on PK `(user_hash, org, day)`
- `users` — `ON CONFLICT DO UPDATE` using `MAX`/`MIN` on every column

Monotonic and order-independent. **The same event delivered twice, by two different
transports, produces byte-identical rows.** So both ingest paths run simultaneously, write
to the same D1, and converge. You delete the tail path only once you've watched them agree —
and nothing changes when you do, because it was writing rows the other path already wrote.

## The data is sufficient — all 14 `CleanEvent` fields survive

| field                                                                                                  | how it survives the OTLP path                    |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `event`, `org`, `client_id`, `request_id`, `chat_type`, `transport`, `tool_name`, `server_id`, `level` | in `SAFE_STRING_ATTRIBUTE_KEYS` — egress raw     |
| `user_id`                                                                                              | emitted by A1; the app hashes it itself (hash A) |
| `total_ms`, `duration_ms`                                                                              | numbers pass through untouched (`redact.ts:150`) |
| `first_interaction`                                                                                    | booleans pass through untouched (same line)      |
| `ts`                                                                                                   | the OTLP log record's native timestamp           |

## C1 — `bt-servant-telemetry`: OTLP receive route **[other repo]**

Add a bearer-authed route that accepts OTLP/HTTP logs (JSON encoding), parses
`resourceLogs → scopeLogs → logRecords`, maps attributes to `CleanEvent`, and calls the
existing `ingestBatch()`. Keep the tail handler running alongside it. D1 schema, KPI
queries, the SvelteKit page, and Zulip digests are untouched.

**The route must hash `user_id` by calling the same `hashUserId()` the tail path calls, with
the same `env.PII_HASH_SALT`.** Not a copy of the function — the same one. That is what makes
both ingest paths produce an identical hash A, and it is the single most important line in
Phase C. It must never store a pre-hashed value off the wire.

Apply the same `isKnownEvent` filter the tail path uses — the OTLP path tees _all_
structured logs, and the existing `telemetry_unknown_event_dropped` drift warning should
keep working.

## C2 — staging dual-write

Split the collector's logs pipeline in two, both fed by the same OTLP receiver:

```yaml
pipelines:
  logs/openobserve: # attributes: delete user_id   → OpenObserve  (hash B only)
  logs/telemetry_app: # attributes: delete user_hash → bt-servant-telemetry (raw user_id)
```

Point `logs/telemetry_app` at the C1 route on `bt-servant-telemetry-dev`. Collector-only
change; the worker is never touched. Bake, then verify `-dev`'s row counts and sampled
`user_hash` values against the tail path.

**Config assertion to add:** `logs/openobserve` must delete `user_id` and `logs/telemetry_app`
must delete `user_hash`. Getting either backwards leaks a raw id into the sink, or feeds the
cohort tables a hash they cannot reproduce. `otelcol validate` will not catch this — it is a
semantic error, not a syntactic one, so it needs a review-checklist line in the runbook.

## C3 — prod dual-write **[requires B3]**

Same two-pipeline split on the prod collector → `bt-servant-telemetry-production`. Bake and
verify.

## C4 — remove the tail path

Drop `bt-servant-telemetry-production` / `bt-servant-telemetry-dev` from `tail_consumers`
(`wrangler.toml:13-15`, `:98-100`) and delete the tail handler in the other repo.

**This is the real prize.** After C4, `bt-servant-telemetry` no longer reads `console.log` at
all — which is what stands between us and #309's "cut the Cloudflare Observability path,"
and which makes A1's compromise (raw `user_id` still in Workers Logs) temporary by design
rather than permanent.

## Why two hashes cannot double-count

The two pseudonyms live in different systems and never meet. **No table, query, or count ever
contains both.**

```
                         user_id (raw)
                              │
   worker ────────────────────┼──────────────────────────────────
     │                        │
     ├─ console.log ─► tail ─►│                    ┌─────────────┐
     │                        ├───────────────────►│ bt-servant- │
     └─ OTLP ─► collector     │  raw user_id       │ telemetry   │
                  ├─ logs/telemetry_app ───────────►│             │
                  │                                 │ HMAC(A) ────┼──► D1
                  │                                 └─────────────┘   hash A ONLY
                  │
                  └─ logs/openobserve ──────────────► OpenObserve
                     (user_hash = HMAC(B))            hash B ONLY
```

- **D1 only ever contains hash A.** Both writers into it — the tail handler and the C1 OTLP
  route — receive raw `user_id` and call the same `hashUserId()` with the same
  `env.PII_HASH_SALT`. Same function, same input, same salt ⇒ same output. The idempotent
  PKs then collapse the two writes onto one row.
- **OpenObserve only ever contains hash B**, and nothing cumulative is computed from it —
  it is a correlation key within a retention window, not a cohort identity.
- **The cohort KPIs read only D1.** `COUNT(DISTINCT user_hash)` is counting hash A values
  exclusively. Hash B is not in that database and could not enter it.

The double-count risk I originally flagged was real, but it belonged to a _different_ design
— one where the OTLP path delivered a pre-hashed value into D1. Two writers putting two
different hashes for the same person into `users` would produce two rows and inflate every
tile. Sending raw `user_id` and hashing at the destination removes that failure mode
entirely.

**The one real cost:** you cannot join an OpenObserve record to a D1 user row by identity —
the hashes are unrelated by design. Correlate on `request_id` instead, which is present in
both and is what you actually want when debugging a specific interaction.

**The one way to break it:** if C1's route ever stores a hash it received off the wire
instead of computing one, D1 gets both hash kinds and the counts inflate. That is why C1
specifies the same function, not a copy, and why `logs/telemetry_app` deletes `user_hash`
before delivery — so there is nothing on the wire for a future maintainer to mistakenly
persist.

---

## Cross-cutting constraints

- **Never put a sampling processor on the logs pipeline.** #309 floats tail sampling as a
  collector feature — fine for traces, but sampled logs would silently undercount distinct
  users and corrupt every cohort tile. Traces-only, always.
- **`bt-servant-tail` stays.** OTel structurally cannot observe isolate deaths (#309). Does
  not affect cohorts; may affect error-rate completeness.
- **Version bump on every PR**, per CLAUDE.md.

## Asks for infra

- R2 bucket + access key for the prod OpenObserve (blocks B2).
- Retention period on the door43 `bt-servant` prod bucket once it auto-creates (B3 step 3).
- fly.io org access, if he is going to own any of B2 / B3.

## Not in scope

- Cutting the Cloudflare Observability / `console.log` path. C4 _unblocks_ it; the decision
  is separate, and #309 wants a parallel bake first.
- Retiring `telemetry.btservant.ai`. Phase C makes it cheaper to keep, not closer to
  deletion — the cohort half still has no home in OpenObserve.
