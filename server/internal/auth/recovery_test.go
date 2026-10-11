package auth_test

import (
	"bytes"
	"regexp"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/auth"
)

func TestRecoveryCodes(t *testing.T) {
	shown, hashes, err := auth.NewRecoveryCodes()
	if err != nil {
		t.Fatal(err)
	}
	if len(shown) != 10 || len(hashes) != 10 {
		t.Fatalf("%d codes, %d hashes", len(shown), len(hashes))
	}
	seen := map[string]bool{}
	for i, c := range shown {
		if !regexp.MustCompile(`^[0-9a-hjkmnp-tv-z]{5}-[0-9a-hjkmnp-tv-z]{5}$`).MatchString(c) {
			t.Fatalf("code %q", c)
		}
		if seen[c] {
			t.Fatalf("code %q twice", c)
		}
		seen[c] = true
		n, ok := auth.NormalizeRecoveryCode(c)
		if !ok || !bytes.Equal(auth.RecoveryCodeHash(n), hashes[i]) {
			t.Fatalf("code %q does not normalize to its hash", c)
		}
	}
}

func TestNormalizeRecoveryCode(t *testing.T) {
	for in, want := range map[string]string{
		"abcde-fgh12":  "abcdefgh12",
		"ABCDE FGH12":  "abcdefgh12",
		" abcdefgh12 ": "abcdefgh12",
		"abcde-fghIL":  "abcdefgh11", // i and l read as 1
		"0oO00-12345":  "0000012345", // o reads as 0
	} {
		if got, ok := auth.NormalizeRecoveryCode(in); !ok || got != want {
			t.Errorf("%q = %q %v, want %q", in, got, ok, want)
		}
	}
	for _, bad := range []string{"", "123456", "abcde-fgh1", "abcde-fgh123", "abcde-fghu1", "abcdé-fgh12", "abcde_fgh12"} {
		if _, ok := auth.NormalizeRecoveryCode(bad); ok {
			t.Errorf("%q accepted", bad)
		}
	}
}
