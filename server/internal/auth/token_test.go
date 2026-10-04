package auth_test

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

// countingStore knows no devices and counts token lookups.
type countingStore struct {
	auth.Store
	lookups atomic.Int32
}

func (s *countingStore) DeviceByTokenHash(context.Context, []byte) (store.Device, error) {
	s.lookups.Add(1)
	return store.Device{}, store.ErrNotFound
}

func TestWellFormedToken(t *testing.T) {
	for i := 0; i < 100; i++ {
		tok, _, err := auth.NewToken()
		if err != nil {
			t.Fatal(err)
		}
		if !auth.WellFormedToken(tok) {
			t.Fatalf("issued token %q is not well formed", tok)
		}
	}
}

// A token the server cannot have issued is refused like an unknown one,
// without a store lookup; a well-formed unknown token costs one lookup.
func TestMalformedTokensSkipTheStore(t *testing.T) {
	st := &countingStore{}
	svc, err := auth.NewService(st, auth.Options{Params: auth.FastParams})
	if err != nil {
		t.Fatal(err)
	}
	good, _, _ := auth.NewToken()
	malformed := []string{
		"",
		"not-a-token",
		good[:42],                        // too short
		good + "A",                       // too long
		good[:42] + "=",                  // padding
		"+" + good[1:],                   // standard-alphabet character
		"/" + good[1:],                   // standard-alphabet character
		" " + good[1:],                   // whitespace
		"é" + good[2:],                   // non-ASCII, same byte length
		good[:42] + "B",                  // non-zero trailing bits: never encoded by the server
		strings.Repeat("A", 42) + "\x00", // NUL
		strings.Repeat("A", 4096),        // oversized
	}
	for _, tok := range malformed {
		if _, err := svc.Authenticate(ctx, tok); !errors.Is(err, auth.ErrUnauthorized) {
			t.Fatalf("Authenticate(%q) = %v, want ErrUnauthorized", tok, err)
		}
	}
	if n := st.lookups.Load(); n != 0 {
		t.Fatalf("malformed tokens caused %d store lookups, want 0", n)
	}
	if _, err := svc.Authenticate(ctx, good); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("unknown well-formed token: %v", err)
	}
	if n := st.lookups.Load(); n != 1 {
		t.Fatalf("well-formed unknown token caused %d lookups, want 1", n)
	}
}
