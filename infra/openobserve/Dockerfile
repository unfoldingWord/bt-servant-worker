# Pins the upstream OpenObserve image at build time so deploys are reproducible.
# Pinned to a specific stable tag (do NOT ship :latest). Override at deploy with
# --build-arg OPENOBSERVE_VERSION=<tag>. Tags: https://gallery.ecr.aws/zinclabs/openobserve
ARG OPENOBSERVE_VERSION=v0.91.0
FROM public.ecr.aws/zinclabs/openobserve:${OPENOBSERVE_VERSION}
