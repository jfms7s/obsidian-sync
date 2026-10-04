package auth_test

import (
	"fmt"
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

// A flood of distinct keys (random usernames) must not grow the limiter past
// its cap, even when every bucket is partially drained and none has refilled.
func TestLoginLimiterIsBounded(t *testing.T) {
	clk := storetest.NewClock()
	l := auth.NewLoginLimiter(3, time.Hour, clk.Now)
	auth.SetMaxTrackedKeys(l, 100)
	for i := 0; i < 1000; i++ {
		l.Take(fmt.Sprintf("user-%d", i))
		if n := auth.TrackedKeys(l); n > 100 {
			t.Fatalf("tracking %d keys after %d takes, cap is 100", n, i+1)
		}
	}
}

// At capacity the least recently used bucket is evicted, so a key that is
// being actively attacked keeps its drained bucket.
func TestLoginLimiterEvictsLeastRecentlyUsed(t *testing.T) {
	clk := storetest.NewClock()
	l := auth.NewLoginLimiter(3, time.Hour, clk.Now)
	auth.SetMaxTrackedKeys(l, 3)
	l.Take("alice") // alice: 2 left
	l.Take("bob")
	l.Take("carol")
	l.Take("alice") // alice: 1 left, now most recently used
	l.Take("dave")  // evicts bob, the least recently used
	l.Take("erin")  // evicts carol
	if n := auth.TrackedKeys(l); n != 3 {
		t.Fatalf("tracking %d keys, want 3", n)
	}
	if !l.Take("alice") {
		t.Fatal("alice's last attempt refused")
	}
	if l.Take("alice") {
		t.Fatal("alice's drained bucket was evicted and refilled")
	}
}
