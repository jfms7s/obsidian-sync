package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunWithoutCommandPrintsUsage(t *testing.T) {
	err := run(context.Background(), nil)
	if err == nil || !strings.Contains(err.Error(), "usage: obsync") {
		t.Fatalf("err = %v", err)
	}
}

func TestRunUnknownCommand(t *testing.T) {
	t.Setenv("OBSYNC_DATA_DIR", t.TempDir())
	if err := run(context.Background(), []string{"frobnicate"}); err == nil {
		t.Fatal("expected an error")
	}
}

func TestMigrateCreatesDatabase(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OBSYNC_DATA_DIR", dir)
	if err := run(context.Background(), []string{"migrate"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "meta.db")); err != nil {
		t.Fatalf("database not created: %v", err)
	}
}

func TestInvalidConfigIsReported(t *testing.T) {
	t.Setenv("OBSYNC_DATA_DIR", t.TempDir())
	t.Setenv("OBSYNC_CLUSTER", "true")
	err := run(context.Background(), []string{"migrate"})
	if err == nil || !strings.Contains(err.Error(), "cluster mode is not available yet") {
		t.Fatalf("err = %v", err)
	}
}
