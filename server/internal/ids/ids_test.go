package ids_test

import (
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/ids"
)

func TestNewIsValidAndUnique(t *testing.T) {
	a, b := ids.New(), ids.New()
	if !ids.Valid(a) || !ids.Valid(b) {
		t.Fatalf("invalid ids %q %q", a, b)
	}
	if a == b {
		t.Fatal("two ids are equal")
	}
}

func TestValidRejects(t *testing.T) {
	for _, s := range []string{"", "ABCDEF0123456789ABCDEF0123456789", "abc", "../../../etc/passwd0000000000000"} {
		if ids.Valid(s) {
			t.Errorf("Valid(%q) = true", s)
		}
	}
}

func TestBytesLength(t *testing.T) {
	if got := len(ids.Bytes(16)); got != 16 {
		t.Fatalf("len = %d", got)
	}
}
