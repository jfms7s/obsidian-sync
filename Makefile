SHELL := /bin/bash
BIN := $(CURDIR)/bin
export PATH := $(BIN):$(PATH)
# go.mod pins the toolchain; an older local Go downloads it once.
export GOTOOLCHAIN := auto
export CGO_ENABLED := 1

.PHONY: tools proto proto-lint test vet lint-go lint check docker-build plugin-test plugin-build plugin-lint plugin-install vectors convergence

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

# Typecheck and the unit and server tests; the convergence suite is `make convergence`.
plugin-test: plugin/node_modules
	cd plugin && npm run typecheck && npx vitest run --project '!convergence'

# plugin/dist/ is the folder to install: main.js, manifest.json, styles.css.
plugin-build: plugin/node_modules
	cd plugin && npm run build

# Obsidian's plugin rules need TypeScript 5.9; the plugin itself builds with 7.
plugin/lint/node_modules: plugin/lint/package.json plugin/lint/package-lock.json
	cd plugin/lint && npm ci
	@touch plugin/lint/node_modules

plugin-lint: plugin/lint/node_modules
	cd plugin/lint && npm run lint

lint: lint-go plugin-lint proto-lint

# The Go and plugin tests, vet, all linters and the plugin build. CI also runs the
# convergence suite (make convergence), the image build, and the generated-code,
# protocol and release-script checks.
check: test vet lint plugin-test plugin-build

# make plugin-install VAULT=~/vaults/test
plugin-install: plugin-build
	@test -n "$(VAULT)" || { echo "usage: make plugin-install VAULT=/path/to/vault" >&2; exit 1; }
	mkdir -p "$(VAULT)/.obsidian/plugins/obsync"
	cp plugin/dist/main.js plugin/dist/manifest.json plugin/dist/styles.css "$(VAULT)/.obsidian/plugins/obsync/"

# Known-answer vectors for the plugin, computed by the Go implementation.
vectors:
	cd server && go run ./cmd/vectorgen -out ../plugin/test/vectors

# CONVERGENCE_SEEDS=1000 make convergence (the nightly and release runs); default 20.
# CONVERGENCE_SEED=123 replays one seed; CONVERGENCE_FIRST_SEED=501 starts at another seed;
# CONVERGENCE_REPORT=file.json keeps what each seed did.
CONVERGENCE_SEEDS ?= 20
convergence: plugin/node_modules
	cd plugin && OBSYNC_CONVERGENCE_SEEDS=$(CONVERGENCE_SEEDS) \
		$(if $(CONVERGENCE_SEED),OBSYNC_CONVERGENCE_SEED=$(CONVERGENCE_SEED)) \
		$(if $(CONVERGENCE_FIRST_SEED),OBSYNC_CONVERGENCE_FIRST_SEED=$(CONVERGENCE_FIRST_SEED)) \
		$(if $(CONVERGENCE_REPORT),OBSYNC_CONVERGENCE_REPORT=$(abspath $(CONVERGENCE_REPORT))) \
		npx vitest run --project convergence

# Single-arch image for the local machine; CI builds both platforms with buildx.
# Podman users: DOCKER_BUILD_FLAGS=--format=docker keeps the HEALTHCHECK.
# Outside a git checkout (a source archive) the version is "dev".
VERSION ?= $(or $(shell git describe --tags --always --dirty 2>/dev/null),dev)
docker-build:
	docker build $(DOCKER_BUILD_FLAGS) --build-arg VERSION=$(VERSION) -t obsync:$(VERSION) .
