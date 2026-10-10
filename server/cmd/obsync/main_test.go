package main

import (
	"bytes"
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

// Commands print through stdout, so tests (and any caller of run) see the output.
func TestCommandsPrintThroughStdout(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"migrate"}, "migrations applied\n"},
		{[]string{"admin", "user", "list"}, "USERNAME  ID  QUOTA_BYTES\n"},
	} {
		var out bytes.Buffer
		restore := swapStdout(&out)
		t.Setenv("OBSYNC_DATA_DIR", t.TempDir())
		err := run(context.Background(), tc.args)
		restore()
		if err != nil {
			t.Fatalf("%v: %v", tc.args, err)
		}
		if out.String() != tc.want {
			t.Fatalf("%v: output = %q, want %q", tc.args, out.String(), tc.want)
		}
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

// OBSYNC_DATA_DIR may name a directory that does not exist yet (a fresh
// install); every command that opens the database creates it, private.
func TestCommandsCreateMissingDataDir(t *testing.T) {
	for _, args := range [][]string{{"migrate"}, {"admin", "user", "list"}} {
		dir := filepath.Join(t.TempDir(), "not", "there")
		t.Setenv("OBSYNC_DATA_DIR", dir)
		if err := run(context.Background(), args); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
		fi, err := os.Stat(dir)
		if err != nil {
			t.Fatalf("%v: %v", args, err)
		}
		if perm := fi.Mode().Perm(); perm != 0o700 {
			t.Fatalf("%v: data dir mode = %o, want 700", args, perm)
		}
	}
}

func TestUnexpectedArgumentsRejected(t *testing.T) {
	t.Setenv("OBSYNC_DATA_DIR", t.TempDir())
	t.Setenv("OBSYNC_LISTEN", "127.0.0.1:0")
	for _, args := range [][]string{{"serve", "extra"}, {"migrate", "extra"}} {
		err := run(context.Background(), args)
		if err == nil || !strings.Contains(err.Error(), "unexpected argument") {
			t.Fatalf("%v: err = %v", args, err)
		}
	}
}

func TestUsageSaysWhereGlobalFlagsGo(t *testing.T) {
	if !strings.Contains(usage, "obsync [--config PATH] <command>") {
		t.Fatalf("usage = %q", usage)
	}
}

func TestConfigFlagBeforeOrAfterCommand(t *testing.T) {
	cfgPath := filepath.Join(t.TempDir(), "obsync.yaml")
	if err := os.WriteFile(cfgPath, []byte("log_level: info\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		{"--config", cfgPath, "migrate"},
		{"migrate", "--config", cfgPath},
		{"--config", cfgPath, "admin", "user", "list"},
		{"admin", "--config", cfgPath, "user", "list"},
	} {
		t.Setenv("OBSYNC_DATA_DIR", t.TempDir())
		if err := run(context.Background(), args); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
	}
	missing := filepath.Join(t.TempDir(), "missing.yaml")
	if err := run(context.Background(), []string{"--config", missing, "migrate"}); err == nil {
		t.Fatal("missing config file not reported")
	}
}
