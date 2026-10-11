# syntax=docker/dockerfile:1.27.1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
#
# (The frontend above is docker/dockerfile 1.27.1, index digest as of 2026-10-11.)
#
# Multi-arch (linux/amd64, linux/arm64) image for the obsync server.
#
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     --build-arg VERSION=$(git describe --tags --always --dirty) -t obsync .
#
# The build stage always runs on the builder's own architecture and
# cross-compiles with CGO for the target, so no emulation is needed to build.
# The libSQL driver links a prebuilt static library that ships inside its Go
# module for linux/amd64 and linux/arm64.

# golang:1.25.14-bookworm, index digest as of 2026-10-05. Bookworm's glibc
# (2.36) matches the runtime image, so the binary cannot need a newer one.
FROM --platform=$BUILDPLATFORM golang:1.25.14-bookworm@sha256:3b4a11519ad929d1e1d261a12cff056f0c85b735253d7d861346b9c6f8b36437 AS build

ARG TARGETARCH
ARG VERSION=dev

# The go.mod pins the toolchain; never download another one during a build.
ENV GOTOOLCHAIN=local \
    CGO_ENABLED=1 \
    GOOS=linux \
    GOARCH=${TARGETARCH}

# A C cross compiler is needed only when the target is not the builder's
# architecture. The chosen compiler is recorded for the build step below.
RUN set -eu; \
    native="$(dpkg --print-architecture)"; \
    if [ "${TARGETARCH}" = "${native}" ]; then \
        echo gcc > /cc; \
    elif [ "${TARGETARCH}" = "arm64" ]; then \
        apt-get update; \
        apt-get install -y --no-install-recommends gcc-aarch64-linux-gnu libc6-dev-arm64-cross; \
        echo aarch64-linux-gnu-gcc > /cc; \
    elif [ "${TARGETARCH}" = "amd64" ]; then \
        apt-get update; \
        apt-get install -y --no-install-recommends gcc-x86-64-linux-gnu libc6-dev-amd64-cross; \
        echo x86_64-linux-gnu-gcc > /cc; \
    else \
        echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1; \
    fi; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /src
# Dependencies first, so editing source does not re-download them.
COPY server/go.mod server/go.sum ./
RUN go mod download && go mod verify
COPY server/ ./

# The Go build cache is a cache mount, so a local rebuild after a source edit
# only recompiles what changed. The module download above stays a plain layer,
# so CI's layer cache (type=gha) keeps it between runs; a cache mount is not
# kept there.
RUN --mount=type=cache,target=/root/.cache/go-build \
    CC="$(cat /cc)" go build -trimpath \
        -ldflags "-s -w -X main.version=${VERSION}" \
        -o /out/obsync ./cmd/obsync \
 # The final image has no shell, so /data is created here and copied over
 # with its owner set, which also makes a fresh named volume writable.
 && mkdir /out/data

# Just the binary, for the release workflow: `--target binary --output type=local,dest=out`
# gives the same bookworm-built executable the image holds (checked against glibc 2.36).
FROM scratch AS binary
COPY --from=build /out/obsync /obsync

# gcr.io/distroless/cc-debian12:nonroot, index digest as of 2026-10-05.
# glibc 2.36, libgcc and libstdc++, CA certificates, tzdata; no shell.
FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f

COPY --from=build /out/obsync /usr/local/bin/obsync
COPY --from=build --chown=65532:65532 /out/data /data

ENV OBSYNC_DATA_DIR=/data
USER nonroot
EXPOSE 8080
VOLUME /data

# `obsync health` probes /readyz on the server's own listen address; it honours
# the same OBSYNC_* environment (and OBSYNC_CONFIG) as `obsync serve`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD ["/usr/local/bin/obsync", "health"]

ENTRYPOINT ["/usr/local/bin/obsync"]
CMD ["serve"]
