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

Since B2 the script also checks the fly.toml side. `INFLUX_BUCKET` used to be a fly
SECRET, which made the one value distinguishing staging from production invisible:
`fly secrets list` prints a digest, never the value, so nothing could tell you which
bucket an app was actually writing to. It now lives in each app's `fly.toml [env]`,
where it is diffable and reviewable — and where a wrong value is a normal code bug,
which is exactly what this file turns into a failed deploy.

Self-tested by tests/test-assert-collector-invariants.sh; run that after editing.
"""

import argparse
import sys
import tomllib
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = REPO_ROOT / "infra/otel-collector/otel-collector-config.yaml"
DEFAULT_FLY_TOMLS = [
    REPO_ROOT / "infra/otel-collector/fly.toml",
    REPO_ROOT / "infra/otel-collector/fly.prod.toml",
]
EXPECTED_BUCKET = "${env:INFLUX_BUCKET}"
INFLUX_EXPORTER = "influxdb/door43_metrics"

# The reviewed bucket↔environment mapping. This table IS the control: a new collector
# app cannot inherit a bucket by accident, it has to be added here in a PR. The two
# buckets are separate door43 tenants, and door43's Nginx validates the bucket against
# the write token — so a swap here does not fail loudly, it writes staging traffic into
# the production series.
APP_BUCKETS = {
    "bt-servant-otel-collector": "bt-servant-staging",
    "bt-servant-otel-collector-prod": "bt-servant",
}

# (annotated file, message). The file is carried per-failure so GitHub puts each
# annotation on the line the reviewer has to edit — a fly.toml complaint filed against
# the collector YAML sends people to the wrong file.
failures: list[tuple[object, str]] = []


def fail(message: str, file: object = None) -> None:
    failures.append((file, message))


def annotate(file: object) -> str:
    """Render a path the way GitHub needs it: relative to the repo root.

    The defaults above are absolute (resolved from __file__ so the break-glass runbook
    can invoke this from any directory), but `::error file=/home/runner/work/...` does
    not attach to anything — GitHub matches repo-relative paths only, and an annotation
    that silently fails to attach is a review comment nobody sees.
    """
    try:
        return str(Path(file).resolve().relative_to(REPO_ROOT))
    except ValueError:
        # Outside the repo — a test fixture in a temp dir, say. Absolute is all we have.
        return str(file)


def check_fly_tomls(paths: list[Path]) -> None:
    """Assert every collector app declares its own, correct, INFLUX_BUCKET."""
    seen: dict[str, Path] = {}

    for path in paths:
        try:
            with open(path, "rb") as handle:
                fly = tomllib.load(handle)
        except FileNotFoundError:
            fail("no such file — a collector app's config is missing entirely", path)
            continue
        except tomllib.TOMLDecodeError as error:
            # flyctl would reject this too, but not until after the deploy job has
            # started; failing in validate keeps the breakage on the PR.
            fail(f"is not valid TOML: {error}", path)
            continue

        app = fly.get("app")
        if not app:
            fail("no `app` key — cannot tell which bucket it should carry", path)
            continue

        expected = APP_BUCKETS.get(app)
        if expected is None:
            fail(
                f"app {app!r} is not in the reviewed bucket map "
                f"({sorted(APP_BUCKETS)}). Add it there — an unmapped collector app "
                f"would deploy with whatever bucket happened to be in its [env].",
                path,
            )
            continue

        if app in seen:
            fail(f"app {app!r} is also declared by {seen[app]}", path)
        seen[app] = path

        bucket = (fly.get("env") or {}).get("INFLUX_BUCKET")
        if bucket is None:
            fail(
                f"[env] INFLUX_BUCKET is missing. The collector resolves an unset "
                f"${{env:INFLUX_BUCKET}} to the empty string and boots healthy, writing "
                f"every metric to bucket=\"\". Expected {expected!r} for app {app!r}.",
                path,
            )
        elif bucket != expected:
            fail(
                f"app {app!r} must write to bucket {expected!r}, got {bucket!r}. "
                f"door43 validates the bucket against the write token, so a swap here "
                f"mixes the two environments' metrics rather than failing.",
                path,
            )

    for app in sorted(set(APP_BUCKETS) - set(seen)):
        fail(
            f"no fly.toml was checked for collector app {app!r} — it is in the bucket map "
            f"but nothing asserted its config, so its bucket is unverified"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "config",
        nargs="?",
        default=DEFAULT_CONFIG,
        type=Path,
        help="collector config YAML (default: infra/otel-collector/otel-collector-config.yaml)",
    )
    parser.add_argument(
        "--fly-toml",
        action="append",
        dest="fly_tomls",
        type=Path,
        help="a collector fly.toml to check (repeatable; defaults to both real ones)",
    )
    args = parser.parse_args()

    path = args.config
    check_fly_tomls(args.fly_tomls or DEFAULT_FLY_TOMLS)

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
        for annotated_file, message in failures:
            print(f"::error file={annotate(annotated_file or path)}::{message}")
        # Not "in {path}" — failures now span the YAML and both fly.tomls, and naming
        # only the YAML sends the reader to a file that may be perfectly fine.
        offenders = sorted({annotate(annotated_file or path) for annotated_file, _ in failures})
        print(f"\n{len(failures)} collector invariant(s) violated across:")
        for offender in offenders:
            print(f"  {offender}")
        return 1

    print(f"All collector invariants hold in {path}:")
    print(f"  bucket is {EXPECTED_BUCKET}")
    print(f"  user_id is deleted (processors.{user_id_rules[0][0]}), on every pipeline")
    print("  debug exporter is unwired")
    for app, bucket in sorted(APP_BUCKETS.items()):
        print(f"  {app} writes to bucket {bucket}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
