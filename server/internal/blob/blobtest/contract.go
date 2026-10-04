// Package blobtest is the behaviour every blob.Store implementation must have.
package blobtest

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
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
		if err := s.Put(ctx, "k", bytes.NewReader([]byte("one"))); err != nil {
			t.Fatal(err)
		}
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
		if err := s.Put(ctx, "k", bytes.NewReader([]byte("x"))); err != nil {
			t.Fatal(err)
		}
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

	t.Run("delete of a key never written", func(t *testing.T) {
		if err := newStore(t).Delete(ctx, "never"); err != nil {
			t.Fatal(err)
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

	t.Run("cancelled context fails put and leaves nothing", func(t *testing.T) {
		s := newStore(t)
		cctx, cancel := context.WithCancel(ctx)
		cancel()
		if err := s.Put(cctx, "k", bytes.NewReader([]byte("x"))); !errors.Is(err, context.Canceled) {
			t.Fatalf("Put err = %v, want context.Canceled", err)
		}
		if _, err := s.Get(ctx, "k"); !errors.Is(err, blob.ErrNotFound) {
			t.Fatalf("blob visible after cancelled put: %v", err)
		}
		if _, err := s.Get(cctx, "k"); !errors.Is(err, context.Canceled) {
			t.Fatalf("Get err = %v, want context.Canceled", err)
		}
		if err := s.Delete(cctx, "k"); !errors.Is(err, context.Canceled) {
			t.Fatalf("Delete err = %v, want context.Canceled", err)
		}
	})

	t.Run("get of a key prefix is not found", func(t *testing.T) {
		s := newStore(t)
		if err := s.Put(ctx, "v1/ab/abcd", bytes.NewReader([]byte("x"))); err != nil {
			t.Fatal(err)
		}
		rc, err := s.Get(ctx, "v1/ab")
		if err == nil {
			rc.Close()
		}
		if !errors.Is(err, blob.ErrNotFound) {
			t.Fatalf("err = %v, want ErrNotFound", err)
		}
	})

	t.Run("large blob round-trips", func(t *testing.T) {
		s := newStore(t)
		want := make([]byte, 4<<20+64)
		for i := range want {
			want[i] = byte(i*31 + i>>8)
		}
		if err := s.Put(ctx, "big", bytes.NewReader(want)); err != nil {
			t.Fatal(err)
		}
		if got := read(t, s, "big"); got != string(want) {
			t.Fatalf("round-trip mismatch: got %d bytes, want %d", len(got), len(want))
		}
	})

	t.Run("concurrent puts of one key leave one complete payload", func(t *testing.T) {
		s := newStore(t)
		const n = 8
		payloads := make(map[string]bool, n)
		var wg sync.WaitGroup
		errs := make(chan error, n)
		for i := 0; i < n; i++ {
			p := bytes.Repeat([]byte(fmt.Sprintf("writer-%d;", i)), 4096)
			payloads[string(p)] = true
			wg.Add(1)
			go func() {
				defer wg.Done()
				errs <- s.Put(ctx, "v1/same", bytes.NewReader(p))
			}()
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			if err != nil {
				t.Fatal(err)
			}
		}
		if got := read(t, s, "v1/same"); !payloads[got] {
			t.Fatalf("stored blob (%d bytes) is not any single writer's payload", len(got))
		}
	})

	t.Run("invalid keys are rejected", func(t *testing.T) {
		s := newStore(t)
		for _, key := range []string{"", "../escape", "a//b", "UPPER", "a/", "/a", ".tmp-x", "a/../b"} {
			if err := s.Put(ctx, key, bytes.NewReader(nil)); err == nil {
				t.Errorf("Put(%q) succeeded", key)
			}
			if _, err := s.Get(ctx, key); err == nil || errors.Is(err, blob.ErrNotFound) {
				t.Errorf("Get(%q) err = %v, want an invalid-key error", key, err)
			}
			if err := s.Delete(ctx, key); err == nil {
				t.Errorf("Delete(%q) succeeded", key)
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
