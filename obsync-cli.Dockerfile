# syntax=docker/dockerfile:1.27.1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
#
# Multi-arch (linux/amd64, linux/arm64) image for obsync-cli, the headless
# client. The image holds one file, /app/obsync-cli.mjs, with every dependency
# inlined, so the build stage runs on the builder's own architecture and the
# result is the same for both platforms.
#
#   docker buildx build -f obsync-cli.Dockerfile --platform linux/amd64,linux/arm64 \
#     -t obsync-cli .
#
# State (the login and the unlocked keys) lives in the /state volume.

# node:22.23.5-bookworm-slim, index digest as of 2026-11-14.
FROM --platform=$BUILDPLATFORM node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build

WORKDIR /src
# manifest.json carries the version the bundle reports.
COPY manifest.json ./
WORKDIR /src/plugin
# Dependencies first, so editing source does not reinstall them.
COPY plugin/package.json plugin/package-lock.json ./
RUN npm ci
COPY plugin/esbuild.config.mjs plugin/tsconfig.json ./
COPY plugin/src ./src
COPY plugin/cli ./cli
RUN npm run build:cli

# The same Node image, for the target platform.
FROM node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

COPY --from=build /src/plugin/dist/obsync-cli.mjs /app/obsync-cli.mjs
# The node user is uid 1000; a fresh named volume takes this owner.
RUN mkdir /state && chown 1000:1000 /state

ENV XDG_STATE_HOME=/state
USER 1000:1000
VOLUME /state

ENTRYPOINT ["node", "/app/obsync-cli.mjs"]
