# Bakes our config into the upstream contrib collector image.
# Pinned to a specific stable tag (do NOT ship :latest). Override at deploy with
# --build-arg OTELCOL_VERSION=<tag>. Tags: https://hub.docker.com/r/otel/opentelemetry-collector-contrib/tags
ARG OTELCOL_VERSION=0.157.0
FROM otel/opentelemetry-collector-contrib:${OTELCOL_VERSION}

# The contrib image's default CMD is `--config /etc/otelcol-contrib/config.yaml`.
COPY otel-collector-config.yaml /etc/otelcol-contrib/config.yaml
