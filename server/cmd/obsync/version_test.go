package main

import (
	"bytes"
	"context"
	"io"
	"strings"
	"testing"
)

func TestVersionPrintsTheBuildVersion(t *testing.T) {
	var out bytes.Buffer
	t.Cleanup(swapStdout(&out))
	old := version
	version = "v1.2.3-test"
	t.Cleanup(func() { version = old })
	if err := run(context.Background(), []string{"version"}); err != nil {
		t.Fatal(err)
	}
	if got := out.String(); got != "obsync v1.2.3-test\n" {
		t.Fatalf("output = %q", got)
	}
}

func TestVersionDefaultsToDev(t *testing.T) {
	if version != "dev" {
		t.Fatalf("version = %q, want dev unless set by -ldflags", version)
	}
}

// version needs no configuration, so a broken environment must not hide it.
func TestVersionIgnoresConfig(t *testing.T) {
	t.Setenv("OBSYNC_CLUSTER", "not-a-bool")
	var out bytes.Buffer
	t.Cleanup(swapStdout(&out))
	if err := run(context.Background(), []string{"version"}); err != nil {
		t.Fatal(err)
	}
}

func TestVersionRejectsArguments(t *testing.T) {
	err := run(context.Background(), []string{"version", "extra"})
	if err == nil || !strings.Contains(err.Error(), "unexpected argument") {
		t.Fatalf("err = %v", err)
	}
}

func TestUsageListsVersion(t *testing.T) {
	if !strings.Contains(usage, "version") {
		t.Fatal("usage does not mention version")
	}
}

// swapStdout redirects the command output and returns the restore function.
func swapStdout(w io.Writer) func() {
	old := stdout
	stdout = w
	return func() { stdout = old }
}
