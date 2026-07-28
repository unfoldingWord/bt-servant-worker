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

Substitute **inside the OTLP branch only** — `buildLogAttributes()`
(`src/services/telemetry/logs.ts:84`), which builds a brand-new object and runs after
`console.log` has already serialized. The console branch is therefore untouched _by
construction_, not by convention.

- New secret `TELEMETRY_USER_ID_SALT`, set to the **same value** as the handrolled app's
  `PII_HASH_SALT` — **per environment**. That app uses a distinct salt per env
  (`../bt-servant-telemetry/docs/implementation-plan.md:89`), so the staging worker takes
  `bt-servant-telemetry-dev`'s salt and the prod worker takes `-production`'s.

  > **BLOCKER — resolve before A1 can be verified.** `PII_HASH_SALT` is a wrangler secret
  > and Cloudflare secrets are write-only; the values cannot be read back from Cloudflare.
  > They must come from wherever they were backed up (that app's plan says the salt is
  > "backed up alongside production secrets" and must never be rotated, `:232`).
  >
  > This is a **correctness** requirement for Phase C, not merely a continuity nicety.
  > During C2/C3 both ingest paths write to the same D1. If the worker's salt differs from
  > the app's, the same person produces two different `user_hash` values ⇒ two rows in
  > `users` ⇒ every cohort tile inflates, silently.
  >
  > If a salt turns out to be unrecoverable, Phase C cannot dual-write safely for that env,
  > and the options are: (a) rotate both sides to a new shared salt and accept a cohort
  > epoch break, or (b) have the OTLP receive route in C1 hash `user_id` itself — which
  > means A1 must keep emitting something it can hash, changing A1's design. Decide before
  > writing A1.

- Compute `HMAC-SHA-256(salt, "${client_id}:${user_id}")`, byte-identical to `hashUserId()`
  in the handrolled app. Identical inputs and salt ⇒ identical pseudonyms ⇒ Phase C can
  consume them directly with full cohort continuity.
- **Hash once per request, at the entry point**, and stash it in `AsyncLocalStorage`.
  `crypto.subtle.sign` is async; `buildLogAttributes` is sync. This pattern already exists
  here — `metrics.ts:426` uses ALS for `metricSuppression`, and `logs.ts:31` notes
  otel-cf-workers installs the global ALS context manager.
- In `buildLogAttributes`, on key `user_id`: emit `user_hash` from ALS, omit the raw value.
  Apply the same substitution in `redactSpan()` for the trace path.
- Drop `user_id` from `SAFE_STRING_ATTRIBUTE_KEYS`; add `user_hash`. The allow-list already
  fails closed, so a future call site passing a raw id gets length-summarized rather than
  leaking.
- **Remove the collector's `attributes/redact` `user_id: hash` action.** Leaving it would
  double-hash and break parity with the handrolled app.
- **Fail closed outside ALS scope.** No pseudonym in context (startup, an unwrapped alarm
  handler) ⇒ omit the identifier entirely. A missing correlation key is recoverable; a
  leaked raw id is not.
- **The OTLP branch must never mutate `entry`.** It currently doesn't. Make it a test.

### Verification — four layers, not confidence

1. **Golden-output test.** Snapshot the exact `console.log` JSON for a representative set of
   events; assert byte-identical before and after. Fails loudly if the console shape ever
   drifts, including from unrelated future PRs.
2. **Consumer contract test.** Run the handrolled `redact()` against before/after log lines
   and assert an identical `CleanEvent` — same `user_hash`, same everything.
3. **No-mutation test.** Deep-freeze the `LogEntry`, run `emitLog`, assert no throw.
4. **Staging bake on live traffic.** Staging feeds a separate instance of the consumer,
   `bt-servant-telemetry-dev`, backed by its own D1 (`wrangler.toml:98-100`). Deploy to
   staging only; confirm row counts keep growing and sampled `user_hash` values are
   unchanged. Production is never involved.

### Caveat to record

This is pseudonymization, not anonymization. Stable pseudonyms remain personal data,
re-identifiable by linkage, and the stability is _required_ for cohort math — the salt can
never be rotated without destroying continuity. It reduces blast radius; it does not retire
the need for a retention and deletion policy.

---

# Phase B — Production OTel bring-up

## B1 — prod `ENVIRONMENT` + collector parameterization + CI/CD

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
- **Remove the `debug` exporter from all three pipelines.** The config's own comment says to
  once the sink is confirmed; `verbosity: detailed` is expensive under real traffic.
- New GitHub Actions workflow: deploy the collector on pushes to `main` touching
  `infra/otel-collector/**`, via `flyctl deploy --remote-only` with a `FLY_API_TOKEN` repo
  secret. `otelcol validate` as a pre-deploy gate — the M0 crash-loop lesson. Deploys both
  the staging and prod collector apps.

## B2 — prod OpenObserve + prod collector config

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

## B3 — provision + enable **[no code; runbook]**

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
| `user_hash`                                                                                            | emitted directly by A1                           |
| `total_ms`, `duration_ms`                                                                              | numbers pass through untouched (`redact.ts:150`) |
| `first_interaction`                                                                                    | booleans pass through untouched (same line)      |
| `ts`                                                                                                   | the OTLP log record's native timestamp           |

## C1 — `bt-servant-telemetry`: OTLP receive route **[other repo]**

Add a bearer-authed route that accepts OTLP/HTTP logs (JSON encoding), parses
`resourceLogs → scopeLogs → logRecords`, maps attributes to `CleanEvent`, and calls the
existing `ingestBatch()`. Keep the tail handler running alongside it. D1 schema, KPI
queries, the SvelteKit page, and Zulip digests are untouched.

Apply the same `isKnownEvent` filter the tail path uses — the OTLP path tees _all_
structured logs, and the existing `telemetry_unknown_event_dropped` drift warning should
keep working.

## C2 — staging dual-write

Add an `otlphttp` exporter to the **staging** collector's logs pipeline, pointed at the C1
route on `bt-servant-telemetry-dev`. Collector-only change; the worker is never touched.
Bake, then verify `-dev`'s row counts and sampled `user_hash` values against the tail path.

## C3 — prod dual-write **[requires B3]**

Same exporter on the prod collector → `bt-servant-telemetry-production`. Bake and verify.

## C4 — remove the tail path

Drop `bt-servant-telemetry-production` / `bt-servant-telemetry-dev` from `tail_consumers`
(`wrangler.toml:13-15`, `:98-100`) and delete the tail handler in the other repo.

**This is the real prize.** After C4, `bt-servant-telemetry` no longer reads `console.log` at
all — which is what stands between us and #309's "cut the Cloudflare Observability path,"
and which makes A1's compromise (raw `user_id` still in Workers Logs) temporary by design
rather than permanent.

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
