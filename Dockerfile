FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM dependencies AS build
COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
COPY shared ./shared
RUN bun run build

FROM dependencies AS verify
COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
COPY shared ./shared
COPY server ./server
COPY tests ./tests
# The tests import the fakes they share with the QA instances (scripts/fakeReportProvider.ts, fakeDocMcp.ts,
# buttonMetrics.ts) and the report eval harness (evals/), and tests/testPorts.test.ts scans scripts/.
COPY scripts ./scripts
COPY evals ./evals
COPY bunfig.toml ./
RUN bun run typecheck && bun test && bun run build

FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS production-dependencies
WORKDIR /app
COPY package.json bun.lock ./
# D545: ONNX Runtime Web ships builds for browsers (WebGPU, WebGL, JSPI, asyncify) and source maps;
# the server loads only its Node entry and the single-threaded SIMD WebAssembly (about 14 MB of 140).
RUN bun install --frozen-lockfile --production \
  && find node_modules/onnxruntime-web/dist -type f ! -name ort.node.min.mjs ! -name ort-wasm-simd-threaded.mjs ! -name ort-wasm-simd-threaded.wasm -delete \
  && rm -rf node_modules/onnxruntime-web/lib \
  && rm -rf node_modules/bare-*
# Lane BACKUP: tar-stream's dependencies pull in the Bare runtime's modules (bare-fs, bare-url, ...), which
# only Bare loads ("bare" export conditions); Bun takes the Node paths, so they are dropped (about 6 MB).

# D545: the local embedding model, fetched from its pinned commit and checked (size and sha256) at build
# time, so a running Nook never downloads it. Root-owned in the image: the app can read it, not change it.
# D548: LOCAL_EMBEDDINGS_MODEL=skip builds without it (135 MB less); the Local kind is then offered only
# when LOCAL_EMBEDDINGS_DIR holds the verified files. D686: include (the default) is multilingual-e5-small,
# english bge-small-en-v1.5 alone (35 MB, for LOCAL_EMBEDDINGS_VARIANT=english), all both (170 MB).
FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS local-model
ARG LOCAL_EMBEDDINGS_MODEL=include
WORKDIR /app
COPY shared/localEmbedding.ts ./shared/localEmbedding.ts
COPY scripts/fetchLocalModel.ts ./scripts/fetchLocalModel.ts
RUN case "$LOCAL_EMBEDDINGS_MODEL" in \
      include) bun scripts/fetchLocalModel.ts /app/models/multilingual-e5-small ;; \
      english) bun scripts/fetchLocalModel.ts /app/models/bge-small-en-v1.5 --variant english ;; \
      all) bun scripts/fetchLocalModel.ts /app/models/multilingual-e5-small && bun scripts/fetchLocalModel.ts /app/models/bge-small-en-v1.5 --variant english ;; \
      skip) mkdir -p /app/models ;; \
      *) echo "LOCAL_EMBEDDINGS_MODEL must be include, english, all, or skip" >&2; exit 1 ;; \
    esac

# Lane BACKUP (D615): Litestream, a pinned release (a static Go binary, so it runs on Alpine's musl), checked
# by sha256 at build time against the values below (from the release's checksums.txt). LITESTREAM=skip builds
# without it (39 MB less); LITESTREAM_ENABLED=true then starts Nook alone, with a warning.
FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS litestream
ARG LITESTREAM=include
ARG TARGETARCH
ENV LITESTREAM_VERSION=0.5.17 \
    LITESTREAM_SHA256_AMD64=cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d \
    LITESTREAM_SHA256_ARM64=f8ca4a050095c1efbda2c4365172e61bf9d955ea0d9ac42f448b52e51819baa5
RUN set -eu; mkdir -p /out; \
    case "$LITESTREAM" in skip) exit 0 ;; include) ;; *) echo "LITESTREAM must be include or skip" >&2; exit 1 ;; esac; \
    case "${TARGETARCH:-amd64}" in \
      amd64) arch=x86_64; sha="$LITESTREAM_SHA256_AMD64" ;; \
      arm64) arch=arm64; sha="$LITESTREAM_SHA256_ARM64" ;; \
      *) echo "No pinned Litestream build for $TARGETARCH; build with LITESTREAM=skip" >&2; exit 1 ;; \
    esac; \
    wget -q -O /tmp/litestream.tar.gz "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-${arch}.tar.gz"; \
    echo "${sha}  /tmp/litestream.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/litestream.tar.gz -C /tmp litestream; \
    install -m 0755 /tmp/litestream /out/litestream; \
    test "$(/out/litestream version)" = "$LITESTREAM_VERSION"

FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS production
WORKDIR /app
ARG APP_VERSION=0.48.1
ARG GIT_SHA=development
ENV NODE_ENV=production \
    PORT=2026 \
    DATA_DIR=/data \
    APP_VERSION=$APP_VERSION \
    GIT_SHA=$GIT_SHA
COPY --chown=bun:bun --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=bun:bun --from=production-dependencies /app/package.json ./package.json
COPY --chown=bun:bun --from=build /app/dist ./dist
COPY --chown=bun:bun server ./server
COPY --chown=bun:bun shared ./shared
COPY --from=local-model /app/models ./models
COPY --from=litestream /out/ /usr/local/bin/
COPY scripts/nook-start.sh ./scripts/nook-start.sh
RUN mkdir -p /data && chown bun:bun /data
USER bun
EXPOSE 2026
HEALTHCHECK --interval=15s --timeout=3s --start-period=8s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:2026/api/health || exit 1
# scripts/nook-start.sh runs `bun server/index.ts`, under Litestream when LITESTREAM_ENABLED=true (D615).
CMD ["/bin/sh", "scripts/nook-start.sh"]
