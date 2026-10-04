// Package blobtest is the behaviour every blob.Store implementation must have.
package blobtest

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/blob"
)

func Run(t *testing.T, newStore func(t *testing.T) blob.Store) {
	ctx := context.Background()

	t.Run("put then get", func(t *testing.T) {
		s := newStore(t)
		if err := s.Put(ctx, "v1/ab/abcd", bytes.NewReader([]byte("hello"))); err != nil {
			t.Fatal(err)
		}
		if got := read(t, s, "v1/ab/abcd"); got != "hello" {
			t.Fatalf("got %q", got)
		}
	})

	t.Run("put overwrites", func(t *testing.T) {
		s := newStore(t)
		_ = s.Put(ctx, "k", bytes.NewReader([]byte("one")))
		if err := s.Put(ctx, "k", bytes.NewReader([]byte("two"))); err != nil {
			t.Fatal(err)
		}
		if got := read(t, s, "k"); got != "two" {
			t.Fatalf("got %q", got)
		}
	})

	t.Run("get missing", func(t *testing.T) {
		s := newStore(t)
		if _, err := s.Get(ctx, "nope"); !errors.Is(err, blob.ErrNotFound) {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("delete is idempotent", func(t *testing.T) {
		s := newStore(t)
		_ = s.Put(ctx, "k", bytes.NewReader([]byte("x")))
		if err := s.Delete(ctx, "k"); err != nil {
			t.Fatal(err)
		}
		if err := s.Delete(ctx, "k"); err != nil {
			t.Fatalf("second delete: %v", err)
		}
		if _, err := s.Get(ctx, "k"); !errors.Is(err, blob.ErrNotFound) {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("failed put leaves nothing", func(t *testing.T) {
		s := newStore(t)
		err := s.Put(ctx, "k", io.MultiReader(bytes.NewReader([]byte("partial")), failingReader{}))
		if err == nil {
			t.Fatal("expected the reader's error")
		}
		if _, err := s.Get(ctx, "k"); !errors.Is(err, blob.ErrNotFound) {
			t.Fatalf("partial blob visible: %v", err)
		}
	})

	t.Run("invalid keys are rejected", func(t *testing.T) {
		s := newStore(t)
		for _, key := range []string{"", "../escape", "a//b", "UPPER", "a/", "/a"} {
			if err := s.Put(ctx, key, bytes.NewReader(nil)); err == nil {
				t.Errorf("Put(%q) succeeded", key)
			}
		}
	})

	t.Run("ping", func(t *testing.T) {
		if err := newStore(t).Ping(ctx); err != nil {
			t.Fatal(err)
		}
	})
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("connection reset") }

func read(t *testing.T, s blob.Store, key string) string {
	t.Helper()
	rc, err := s.Get(context.Background(), key)
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	b, err := io.ReadAll(rc)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
