# Bakes our config into the upstream contrib collector image.
# Pin OTELCOL_VERSION to a specific stable tag before real use — do NOT ship :latest.
# Tags: https://hub.docker.com/r/otel/opentelemetry-collector-contrib/tags
ARG OTELCOL_VERSION=latest
FROM otel/opentelemetry-collector-contrib:${OTELCOL_VERSION}

# The contrib image's default CMD is `--config /etc/otelcol-contrib/config.yaml`.
COPY otel-collector-config.yaml /etc/otelcol-contrib/config.yaml
