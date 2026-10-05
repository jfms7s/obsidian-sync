SHELL := /bin/bash
BIN := $(CURDIR)/bin
export PATH := $(BIN):$(PATH)
# go.mod pins the toolchain; an older local Go downloads it once.
export GOTOOLCHAIN := auto
export CGO_ENABLED := 1

.PHONY: tools proto proto-lint test vet lint-go docker-build plugin-test vectors convergence

tools: plugin/node_modules
	GOBIN=$(BIN) go install github.com/bufbuild/buf/cmd/buf@v1.47.2
	GOBIN=$(BIN) go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.12
	GOBIN=$(BIN) go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.14.0

# protoc-gen-es comes from the plugin's pinned devDependencies.
plugin/node_modules: plugin/package.json plugin/package-lock.json
	cd plugin && npm ci
	@touch plugin/node_modules

proto-lint:
	buf lint

proto: proto-lint plugin/node_modules
	buf generate

test:
	cd server && go test -race ./...

vet:
	cd server && go vet ./...

lint-go:
	cd server && golangci-lint run ./...

plugin-test: plugin/node_modules
	cd plugin && npm run typecheck && npm test

# Known-answer vectors for the plugin, computed by the Go implementation.
vectors:
	cd server && go run ./cmd/vectorgen -out ../plugin/test/vectors

# CONVERGENCE_SEEDS=1000 make convergence (plan 3's CI); default 20.
convergence: plugin/node_modules
	cd plugin && OBSYNC_CONVERGENCE_SEEDS=$${CONVERGENCE_SEEDS:-20} npx vitest run --project convergence

# Single-arch image for the local machine; CI builds both platforms with buildx.
# Podman users: DOCKER_BUILD_FLAGS=--format=docker keeps the HEALTHCHECK.
VERSION ?= $(shell git describe --tags --always --dirty)
docker-build:
	docker build $(DOCKER_BUILD_FLAGS) --build-arg VERSION=$(VERSION) -t obsync:$(VERSION) .
