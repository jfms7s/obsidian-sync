package auth_test

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
)

func TestLoginLimiter(t *testing.T) {
	clk := storetest.NewClock()
	l := auth.NewLoginLimiter(3, time.Minute, clk.Now)
	for i := 0; i < 3; i++ {
		if !l.Take("alice") {
			t.Fatalf("attempt %d refused", i)
		}
	}
	if l.Take("alice") {
		t.Fatal("4th attempt allowed")
	}
	if !l.Take("bob") {
		t.Fatal("limits leak between keys")
	}
	clk.Advance(time.Minute)
	if !l.Take("alice") {
		t.Fatal("no refill after a minute")
	}
	if l.Take("alice") {
		t.Fatal("refill granted more than one attempt")
	}
	l.Reset("alice")
	if !l.Take("alice") {
		t.Fatal("reset did not clear")
	}
}

func TestLoginLimiterTakeIsAtomic(t *testing.T) {
	l := auth.NewLoginLimiter(5, time.Hour, time.Now)
	var granted atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if l.Take("alice") {
				granted.Add(1)
			}
		}()
	}
	wg.Wait()
	if n := granted.Load(); n != 5 {
		t.Fatalf("granted %d attempts, want 5", n)
	}
}

func TestNewLoginLimiterRejectsBadSettings(t *testing.T) {
	for _, tc := range []struct {
		name   string
		burst  int
		refill time.Duration
	}{{"zero refill", 5, 0}, {"negative refill", 5, -time.Second}, {"zero burst", 0, time.Minute}} {
		t.Run(tc.name, func(t *testing.T) {
			defer func() {
				if recover() == nil {
					t.Fatal("no panic")
				}
			}()
			auth.NewLoginLimiter(tc.burst, tc.refill, time.Now)
		})
	}
}
