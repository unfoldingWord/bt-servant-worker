#!/usr/bin/env python3
"""Assert the collector config's privacy and parameterization invariants.

These are POSITIVE, EXACT assertions on the PARSED YAML — not text greps. The
grep version of this check was bypassable three ways, each of which reintroduced
the exact bug the check exists to prevent:

  * `bucket: ${env:INFLUX_BUKCET}` (typo) — "starts with ${env:" was enough to pass,
    and a misspelled variable resolves to "" at runtime, silently sending every
    metric to bucket="".
  * no `user_id` action at all — absence passed, but absence means the raw
    identifier is forwarded to every sink. Absent is NOT equivalent to deleted.
  * the block form
        - key: user_id
          action: hash
    — the grep only understood the inline flow-map form.

`otelcol validate` catches none of this: it type-checks the config, it does not
know which values we consider load-bearing.
"""

import sys

import yaml

DEFAULT_CONFIG = "infra/otel-collector/otel-collector-config.yaml"
EXPECTED_BUCKET = "${env:INFLUX_BUCKET}"
INFLUX_EXPORTER = "influxdb/door43_metrics"

failures: list[str] = []


def fail(message: str) -> None:
    failures.append(message)


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_CONFIG
    with open(path, encoding="utf-8") as handle:
        config = yaml.safe_load(handle)

    if not isinstance(config, dict):
        print(f"::error file={path}::config did not parse as a YAML mapping")
        return 1

    exporters = config.get("exporters") or {}
    processors = config.get("processors") or {}
    pipelines = ((config.get("service") or {}).get("pipelines")) or {}

    # ── 1. The InfluxDB bucket must be EXACTLY the expected env reference. ──────
    # Anything else — a hardcoded name, a typo'd variable — either pins both
    # environments to one bucket or resolves to "" and loses metrics silently.
    influx = exporters.get(INFLUX_EXPORTER)
    if not isinstance(influx, dict):
        fail(f"exporters.{INFLUX_EXPORTER} is missing")
    elif influx.get("bucket") != EXPECTED_BUCKET:
        fail(
            f"exporters.{INFLUX_EXPORTER}.bucket must be exactly "
            f"{EXPECTED_BUCKET!r} (got {influx.get('bucket')!r})"
        )

    # ── 2. Exactly one user_id rule, it must DELETE, and it must be on a ────────
    # processor that every pipeline actually runs. A delete rule sitting in an
    # unwired processor protects nothing.
    user_id_rules = []
    for processor_name, processor in processors.items():
        if not isinstance(processor, dict):
            continue
        for action in processor.get("actions") or []:
            if isinstance(action, dict) and action.get("key") == "user_id":
                user_id_rules.append((processor_name, action.get("action")))

    if len(user_id_rules) != 1:
        fail(
            f"expected exactly ONE user_id action across all processors, found "
            f"{len(user_id_rules)}: {user_id_rules!r}. Absence is not deletion — "
            f"with no rule the raw identifier reaches every sink."
        )
    else:
        processor_name, verb = user_id_rules[0]
        if verb != "delete":
            fail(
                f"processors.{processor_name} user_id action must be 'delete', got "
                f"{verb!r}. The collector's 'hash' is UNSALTED and reversible for "
                f"enumerable ids; the worker already emits a salted user_hash."
            )
        for pipeline_name, pipeline in pipelines.items():
            if not isinstance(pipeline, dict):
                continue
            if processor_name not in (pipeline.get("processors") or []):
                fail(
                    f"service.pipelines.{pipeline_name} does not run "
                    f"processors.{processor_name}, so its user_id is never deleted"
                )

    # ── 3. The debug exporter must stay unwired. ────────────────────────────────
    # verbosity: detailed prints every record; it is a bring-up aid only.
    for pipeline_name, pipeline in pipelines.items():
        if not isinstance(pipeline, dict):
            continue
        if "debug" in (pipeline.get("exporters") or []):
            fail(
                f"service.pipelines.{pipeline_name} exports to 'debug'; that is a "
                f"bring-up aid and is far too expensive under real traffic"
            )

    if failures:
        for message in failures:
            print(f"::error file={path}::{message}")
        print(f"\n{len(failures)} collector invariant(s) violated in {path}")
        return 1

    print(f"All collector invariants hold in {path}:")
    print(f"  bucket is {EXPECTED_BUCKET}")
    print(f"  user_id is deleted (processors.{user_id_rules[0][0]}), on every pipeline")
    print("  debug exporter is unwired")
    return 0


if __name__ == "__main__":
    sys.exit(main())
