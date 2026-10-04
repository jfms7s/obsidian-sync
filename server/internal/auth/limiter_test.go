package auth_test

import (
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
)

func TestLoginLimiter(t *testing.T) {
	clk := storetest.NewClock()
	l := auth.NewLoginLimiter(3, time.Minute, clk.Now)
	for i := 0; i < 3; i++ {
		if !l.Allow("alice") {
			t.Fatalf("attempt %d refused", i)
		}
		l.Fail("alice")
	}
	if l.Allow("alice") {
		t.Fatal("4th attempt allowed")
	}
	if !l.Allow("bob") {
		t.Fatal("limits leak between keys")
	}
	clk.Advance(time.Minute)
	if !l.Allow("alice") {
		t.Fatal("no refill after a minute")
	}
	l.Fail("alice")
	if l.Allow("alice") {
		t.Fatal("refill granted more than one attempt")
	}
	l.Reset("alice")
	if !l.Allow("alice") {
		t.Fatal("reset did not clear")
	}
}
