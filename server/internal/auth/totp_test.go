package auth_test

import (
	"strings"
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/auth"
)

// RFC 6238 appendix B, SHA-1, with the 6-digit codes the apps show (the low
// six digits of the RFC's 8-digit values).
func TestTOTPRFC6238Vectors(t *testing.T) {
	secret := []byte("12345678901234567890")
	for _, tc := range []struct {
		unix int64
		code string
	}{
		{59, "287082"},
		{1111111109, "081804"},
		{1111111111, "050471"},
		{1234567890, "005924"},
		{2000000000, "279037"},
		{20000000000, "353130"},
	} {
		if got := auth.TOTPCode(secret, auth.TOTPStep(time.Unix(tc.unix, 0))); got != tc.code {
			t.Errorf("T=%d: code %s, want %s", tc.unix, got, tc.code)
		}
	}
}

func TestVerifyTOTPWindowAndReplay(t *testing.T) {
	secret := []byte("12345678901234567890")
	now := time.Unix(1234567890, 0)
	cur := auth.TOTPStep(now)
	code := func(step int64) string { return auth.TOTPCode(secret, step) }

	for _, d := range []int64{-1, 0, 1} {
		step, ok := auth.VerifyTOTP(secret, code(cur+d), now, 0)
		if !ok || step != cur+d {
			t.Errorf("step %+d: ok=%v step=%d", d, ok, step)
		}
	}
	for _, d := range []int64{-2, 2, 10} {
		if _, ok := auth.VerifyTOTP(secret, code(cur+d), now, 0); ok {
			t.Errorf("step %+d accepted; only one step either side is", d)
		}
	}
	// A step at or below the last accepted one is a replay.
	if _, ok := auth.VerifyTOTP(secret, code(cur), now, cur); ok {
		t.Error("the last accepted step was accepted again")
	}
	if _, ok := auth.VerifyTOTP(secret, code(cur-1), now, cur); ok {
		t.Error("an older step was accepted after a newer one")
	}
	if step, ok := auth.VerifyTOTP(secret, code(cur+1), now, cur); !ok || step != cur+1 {
		t.Error("the next step was refused")
	}
	for _, bad := range []string{"", "12345", "1234567", "abcdef", "２８７０８２", "+12345"} {
		if _, ok := auth.VerifyTOTP(secret, bad, now, 0); ok {
			t.Errorf("%q accepted", bad)
		}
	}
	// Spaces, as apps show the code ("123 456") or as a paste brings them, are fine.
	c := code(cur)
	if _, ok := auth.VerifyTOTP(secret, " "+c[:3]+" "+c[3:]+" ", now, 0); !ok {
		t.Error("a code written with spaces was refused")
	}
}

func TestTOTPSecretAndURI(t *testing.T) {
	s, err := auth.NewTOTPSecret()
	if err != nil {
		t.Fatal(err)
	}
	if len(s) != 20 {
		t.Fatalf("secret is %d bytes, want 20 (160 bits)", len(s))
	}
	b32 := auth.TOTPSecretText(s)
	if len(b32) != 32 || strings.ContainsAny(b32, "=") {
		t.Fatalf("secret text %q", b32)
	}
	uri := auth.TOTPURI("alice@example.com", s)
	want := "otpauth://totp/obsync:alice@example.com?algorithm=SHA1&digits=6&issuer=obsync&period=30&secret=" + b32
	if uri != want {
		t.Fatalf("uri = %s\nwant  %s", uri, want)
	}
}
