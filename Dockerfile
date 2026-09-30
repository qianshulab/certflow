# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM debian:bookworm-slim AS lego-download
ARG TARGETARCH
RUN test "$TARGETARCH" = "amd64" \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl --fail --location --retry 3 --proto '=https' --tlsv1.2 \
       https://github.com/go-acme/lego/releases/download/v5.5.2/lego_v5.5.2_linux_amd64.tar.gz \
       --output /tmp/lego.tar.gz \
    && echo '2a35505089e7772c92e1e9ac144df91151ef2eca8568630db0ff91fca06d9bef  /tmp/lego.tar.gz' | sha256sum --check - \
    && mkdir /out \
    && tar --extract --gzip --file /tmp/lego.tar.gz --directory /out lego LICENSE \
    && chmod 755 /out/lego

FROM node:22-bookworm-slim
ARG VERSION=0.5.0
ARG REVISION=unknown
LABEL org.opencontainers.image.title="CertFlow" \
    org.opencontainers.image.description="HTTPS certificate issuance, renewal and management for NAS" \
    org.opencontainers.image.source="https://github.com/qianshulab/certflow" \
    org.opencontainers.image.version=$VERSION \
    org.opencontainers.image.revision=$REVISION
ENV NODE_ENV=production \
    CERTFLOW_HOST=0.0.0.0 \
    CERTFLOW_PORT=3390 \
    CERTFLOW_CONFIG=/data/cert-config.json
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /app /data \
    && chown node:node /data \
    && chmod 700 /data
WORKDIR /app
COPY --from=lego-download /out/lego /usr/local/bin/lego
COPY --from=lego-download /out/LICENSE /usr/share/licenses/lego/LICENSE
COPY --chown=root:root package.json server.mjs cli.mjs cert-config.example.json ./
COPY --chown=root:root src/ ./src/
COPY --chown=root:root web/ ./web/
USER node
EXPOSE 3390
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "server.mjs", "--healthcheck"]
CMD ["node", "server.mjs"]
