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
# cross-compiles for the target: the server is pure Go (CGO_ENABLED=0), so
# neither emulation nor a C cross compiler is needed, and the binary is static.

# golang:1.27.3-bookworm, index digest as of 2026-11-01.
FROM --platform=$BUILDPLATFORM golang:1.27.3-bookworm@sha256:d9b6a1beb9474adc2a1ce842573639b44b2a0dd49b6669f51d3821baf9ec37c9 AS build

ARG TARGETARCH
ARG VERSION=dev

# The go.mod pins the toolchain; never download another one during a build.
ENV GOTOOLCHAIN=local \
    CGO_ENABLED=0 \
    GOOS=linux \
    GOARCH=${TARGETARCH}

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
    go build -trimpath \
        -ldflags "-s -w -X main.version=${VERSION}" \
        -o /out/obsync ./cmd/obsync \
 # The final image has no shell, so /data is created here and copied over
 # with its owner set, which also makes a fresh named volume writable. Mode
 # 0700: the database holds password and token hashes (COPY keeps the mode).
 && mkdir -m 0700 /out/data

# Just the binary, for the release workflow: `--target binary --output type=local,dest=out`
# gives the same static executable the image holds.
FROM scratch AS binary
COPY --from=build /out/obsync /obsync

# gcr.io/distroless/static-debian12:nonroot, index digest as of 2026-10-11.
# CA certificates, tzdata and the nonroot user; no libc, no shell.
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab

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
