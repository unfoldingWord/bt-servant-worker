# Pins the upstream OpenObserve image at build time so deploys are reproducible.
# Pin OPENOBSERVE_VERSION to a specific stable tag before real use — do NOT ship :latest.
# Tags: https://gallery.ecr.aws/zinclabs/openobserve
ARG OPENOBSERVE_VERSION=latest
FROM public.ecr.aws/zinclabs/openobserve:${OPENOBSERVE_VERSION}
