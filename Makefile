SHELL := /bin/bash
BIN := $(CURDIR)/bin
export PATH := $(BIN):$(PATH)
# go.mod pins the toolchain; an older local Go downloads it once.
export GOTOOLCHAIN := auto
# The server is pure Go: builds are static and need no C compiler. Only the
# race detector needs cgo (and so a C compiler), for make test.
export CGO_ENABLED := 0

.PHONY: tools proto proto-lint test vet lint-go lint check ci-local docker-build plugin-test plugin-build plugin-lint plugin-install vectors convergence cli-build

# go install picks a toolchain from each tool's own go.mod; build them with the
# server's instead, since golangci-lint refuses code newer than the Go it was
# built with.
tools: plugin/node_modules
	@set -e; export GOTOOLCHAIN="$$(cd server && go env GOVERSION)"; \
	GOBIN=$(BIN) go install github.com/bufbuild/buf/cmd/buf@v1.47.2; \
	GOBIN=$(BIN) go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.12; \
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
	cd server && CGO_ENABLED=1 go test -race ./...

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

# The headless client: plugin/dist/obsync-cli.mjs, run with `node obsync-cli.mjs` (Node 22.12+).
cli-build: plugin/node_modules
	cd plugin && npm run build:cli

# Obsidian's plugin rules need TypeScript 5.9; the plugin itself builds with 7.
plugin/lint/node_modules: plugin/lint/package.json plugin/lint/package-lock.json
	cd plugin/lint && npm ci
	@touch plugin/lint/node_modules

plugin-lint: plugin/lint/node_modules
	cd plugin/lint && npm run lint

lint: lint-go plugin-lint proto-lint

# The Go and plugin tests, vet, all linters and the plugin build. CI also runs the
# convergence suite (make convergence), the image build, and the generated-code,
# protocol and release-script checks; make ci-local adds those last three.
check: test vet lint plugin-test plugin-build

# What CI's checks run (.github/workflows/checks.yml), without the convergence
# suite and the image build: make check, generated code and vectors up to date,
# buf breaking against where this branch left origin/main, the release script
# tests, and a bundle that needs nothing but obsidian. Regenerating must not
# change the tree, so a hand-edited vector or a stale generated file fails it.
ci-local: check
	@set -e; \
	before="$$( { git status --porcelain; git diff; } | sha256sum)"; \
	$(MAKE) --no-print-directory proto vectors; \
	after="$$( { git status --porcelain; git diff; } | sha256sum)"; \
	if [ "$$before" != "$$after" ]; then \
		echo "ci-local: make proto vectors changed the tree: generated code or vectors are out of date" >&2; \
		git status --porcelain >&2; exit 1; \
	fi
	buf breaking --against ".git#ref=$$(git merge-base origin/main HEAD)"
	scripts/check-release-version_test.sh
	! grep -oE 'require\("[^"]+"\)' plugin/dist/main.js | grep -v 'require("obsidian")'

# make plugin-install VAULT=~/vaults/test [CONFIG_DIR=.obsidian]
# CONFIG_DIR is the vault's configuration folder (Obsidian lets you rename it).
CONFIG_DIR ?= .obsidian
plugin-install:
	@test -n "$(VAULT)" || { echo "usage: make plugin-install VAULT=/path/to/vault [CONFIG_DIR=.obsidian]" >&2; exit 1; }
	$(MAKE) --no-print-directory plugin-build
	mkdir -p "$(VAULT)/$(CONFIG_DIR)/plugins/obsync"
	cp plugin/dist/main.js plugin/dist/manifest.json plugin/dist/styles.css "$(VAULT)/$(CONFIG_DIR)/plugins/obsync/"

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
