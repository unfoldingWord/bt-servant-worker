#!/usr/bin/env python3
"""Assert the collector config's privacy and parameterization invariants.

These are POSITIVE, EXACT assertions on the PARSED YAML — not text greps. The
grep version of this check was bypassable three ways, each of which reintroduced
the exact bug the check exists to prevent:

  * `username: ${env:MIMIR_USRE}` (typo) — "starts with ${env:" was enough to pass,
    and a misspelled variable resolves to "" at runtime, so every export is a 401
    from Mimir while the collector reports healthy.
  * no `user_id` action at all — absence passed, but absence means the raw
    identifier is forwarded to every sink. Absent is NOT equivalent to deleted.
  * the block form
        - key: user_id
          action: hash
    — the grep only understood the inline flow-map form.

`otelcol validate` catches none of this: it type-checks the config, it does not
know which values we consider load-bearing.

Since B2 the script also checks the fly.toml side. The value that distinguishes staging
from production (originally the InfluxDB bucket, now the Mimir username, which selects
the Mimir org) used to be a fly SECRET, which made it invisible: `fly secrets list`
prints a digest, never the value, so nothing could tell you which org an app was
actually writing to. It now lives in each app's `fly.toml [env]`, where it is diffable
and reviewable — and where a wrong value is a normal code bug, which is exactly what
this file turns into a failed deploy.

The Mimir move added one more invariant: the worker emits DELTA temporality (ephemeral
isolates) and Mimir, being Prometheus-shaped, expects CUMULATIVE. The `deltatocumulative`
processor is the bridge, and a Mimir pipeline without it still validates and boots — so
only this script can notice it is missing.

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
EXPECTED_MIMIR_USER = "${env:MIMIR_USER}"
MIMIR_AUTH_EXTENSION = "basicauth/mimir"
MIMIR_EXPORTER = "otlp_http/mimir_metrics"
DELTA_PROCESSOR = "deltatocumulative"

# The reviewed user↔environment mapping. This table IS the control: a new collector app
# cannot inherit a Mimir user by accident, it has to be added here in a PR. Each username
# resolves to its own Mimir org (door43 fixes the mapping), and Mimir accepts any valid
# credential — so a swap here does not fail loudly, it writes staging traffic into the
# production org's series.
APP_MIMIR_USERS = {
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
    """Assert every collector app declares its own, correct, MIMIR_USER."""
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
            fail("no `app` key — cannot tell which Mimir user it should carry", path)
            continue

        expected = APP_MIMIR_USERS.get(app)
        if expected is None:
            fail(
                f"app {app!r} is not in the reviewed Mimir-user map "
                f"({sorted(APP_MIMIR_USERS)}). Add it there — an unmapped collector app "
                f"would deploy with whatever user happened to be in its [env].",
                path,
            )
            continue

        if app in seen:
            fail(f"app {app!r} is also declared by {seen[app]}", path)
        seen[app] = path

        user = (fly.get("env") or {}).get("MIMIR_USER")
        if user is None:
            fail(
                f"[env] MIMIR_USER is missing. The collector resolves an unset "
                f"${{env:MIMIR_USER}} to the empty string and boots healthy, and every "
                f"metrics export is then a 401 from Mimir. Expected {expected!r} for app "
                f"{app!r}.",
                path,
            )
        elif user != expected:
            fail(
                f"app {app!r} must authenticate to Mimir as {expected!r}, got {user!r}. "
                f"The username selects the Mimir org, so a swap here mixes the two "
                f"environments' metrics rather than failing.",
                path,
            )

    for app in sorted(set(APP_MIMIR_USERS) - set(seen)):
        fail(
            f"no fly.toml was checked for collector app {app!r} — it is in the Mimir-user "
            f"map but nothing asserted its config, so its user is unverified"
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

    extensions = config.get("extensions") or {}
    exporters = config.get("exporters") or {}
    processors = config.get("processors") or {}
    service = config.get("service") or {}
    pipelines = service.get("pipelines") or {}

    # ── 1. The Mimir credential path must be EXACTLY the expected shape. ────────
    # The username is what selects the Mimir org. Anything other than the env reference —
    # a hardcoded name, a typo'd variable — either pins both environments to one org or
    # resolves to "" and turns every export into a 401 while the collector stays healthy.
    # The exporter must authenticate THROUGH the extension (not via an ad-hoc header), and
    # the extension must be enabled in service.extensions or it never runs.
    auth = extensions.get(MIMIR_AUTH_EXTENSION)
    if not isinstance(auth, dict):
        fail(f"extensions.{MIMIR_AUTH_EXTENSION} is missing")
    else:
        username = (auth.get("client_auth") or {}).get("username")
        if username != EXPECTED_MIMIR_USER:
            fail(
                f"extensions.{MIMIR_AUTH_EXTENSION}.client_auth.username must be exactly "
                f"{EXPECTED_MIMIR_USER!r} (got {username!r})"
            )

    mimir = exporters.get(MIMIR_EXPORTER)
    if not isinstance(mimir, dict):
        fail(f"exporters.{MIMIR_EXPORTER} is missing")
    else:
        authenticator = (mimir.get("auth") or {}).get("authenticator")
        if authenticator != MIMIR_AUTH_EXTENSION:
            fail(
                f"exporters.{MIMIR_EXPORTER}.auth.authenticator must be exactly "
                f"{MIMIR_AUTH_EXTENSION!r} (got {authenticator!r})"
            )

    if MIMIR_AUTH_EXTENSION not in (service.get("extensions") or []):
        fail(
            f"service.extensions does not enable {MIMIR_AUTH_EXTENSION}; a defined but "
            f"unlisted extension never runs, so the exporter would send no credentials"
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

    # ── 4. Every pipeline that reaches Mimir must convert DELTA → CUMULATIVE. ───
    # The worker emits DELTA on purpose (ephemeral isolates). Mimir expects CUMULATIVE
    # and, without the bridge, rejects or mis-types every sample — while the config
    # validates and the collector boots and reports healthy. The exporter must also be
    # wired into at least one pipeline, or Mimir simply receives nothing.
    mimir_pipelines = [
        name
        for name, pipeline in pipelines.items()
        if isinstance(pipeline, dict) and MIMIR_EXPORTER in (pipeline.get("exporters") or [])
    ]
    if not mimir_pipelines:
        fail(f"no pipeline exports to {MIMIR_EXPORTER}, so Mimir receives nothing")
    for pipeline_name in mimir_pipelines:
        procs = pipelines[pipeline_name].get("processors") or []
        if DELTA_PROCESSOR not in procs:
            fail(
                f"service.pipelines.{pipeline_name} exports to {MIMIR_EXPORTER} without "
                f"running processors.{DELTA_PROCESSOR}; the worker emits DELTA and Mimir "
                f"expects CUMULATIVE, so every sample would be rejected or mis-typed"
            )
        # ── 5. ...and it must run BEFORE batch. ──────────────────────────────────
        # The worker serializes an isolate's flushes on the receiver's acknowledgement,
        # and the receiver acknowledges once the synchronous processors have consumed
        # the batch. With the conversion before `batch`, "acknowledged" means "already
        # accumulated", so a stream's deltas fold in collection order. After `batch`,
        # the ack says nothing about accumulation order and the processor's
        # strict-ordering rule starts dropping real samples.
        elif "batch" in procs and procs.index("batch") < procs.index(DELTA_PROCESSOR):
            fail(
                f"service.pipelines.{pipeline_name} runs processors.{DELTA_PROCESSOR} "
                f"after batch; it must precede batch so the receiver's acknowledgement "
                f"(which the worker serializes its flushes on) implies the delta has "
                f"already been accumulated"
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
    print(f"  {MIMIR_AUTH_EXTENSION} username is {EXPECTED_MIMIR_USER}, used by {MIMIR_EXPORTER}")
    print(f"  user_id is deleted (processors.{user_id_rules[0][0]}), on every pipeline")
    print("  debug exporter is unwired")
    print(
        f"  {DELTA_PROCESSOR} runs before batch on every Mimir pipeline "
        f"({', '.join(mimir_pipelines)})"
    )
    for app, user in sorted(APP_MIMIR_USERS.items()):
        print(f"  {app} authenticates to Mimir as {user}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
