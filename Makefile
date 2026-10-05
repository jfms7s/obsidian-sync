SHELL := /bin/bash
BIN := $(CURDIR)/bin
export PATH := $(BIN):$(PATH)
# go.mod pins the toolchain; an older local Go downloads it once.
export GOTOOLCHAIN := auto
export CGO_ENABLED := 1

.PHONY: tools proto proto-lint test vet plugin-test vectors

tools: plugin/node_modules
	GOBIN=$(BIN) go install github.com/bufbuild/buf/cmd/buf@v1.47.2
	GOBIN=$(BIN) go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.12

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

plugin-test: plugin/node_modules
	cd plugin && npm run typecheck && npm test

# Known-answer vectors for the plugin, computed by the Go implementation.
vectors:
	cd server && go run ./cmd/vectorgen -out ../plugin/test/vectors
