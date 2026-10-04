SHELL := /bin/bash
BIN := $(CURDIR)/bin
export PATH := $(BIN):$(PATH)
export GOTOOLCHAIN := local
export CGO_ENABLED := 1

.PHONY: tools proto proto-lint test vet

tools:
	GOBIN=$(BIN) go install github.com/bufbuild/buf/cmd/buf@v1.47.2
	GOBIN=$(BIN) go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.35.2

proto-lint:
	buf lint

proto: proto-lint
	buf generate

test:
	cd server && go test -race ./...

vet:
	cd server && go vet ./...
