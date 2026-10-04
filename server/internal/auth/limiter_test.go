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
// its cap, even when every bucket is partially drained and none has refilled
// (new keys are then refused rather than tracked).
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

// At capacity the least recently used bucket that has refilled is evicted,
// so a key that is being actively attacked keeps its drained bucket.
func TestLoginLimiterEvictsLeastRecentlyUsed(t *testing.T) {
	clk := storetest.NewClock()
	l := auth.NewLoginLimiter(3, time.Hour, clk.Now)
	auth.SetMaxTrackedKeys(l, 3)
	l.Take("alice")
	l.Take("alice") // alice: 1 left
	l.Take("bob")
	l.Take("carol")
	clk.Advance(time.Hour) // bob and carol refill to 3; alice only to 2
	l.Take("alice")        // alice: 1 left, now most recently used
	if !l.Take("dave") {   // evicts bob, the least recently used
		t.Fatal("dave refused")
	}
	if !l.Take("erin") { // evicts carol
		t.Fatal("erin refused")
	}
	if n := auth.TrackedKeys(l); n != 3 {
		t.Fatalf("tracking %d keys, want 3", n)
	}
	if auth.Tracks(l, "bob") || auth.Tracks(l, "carol") {
		t.Fatal("bob and carol should have been evicted")
	}
	if !l.Take("alice") {
		t.Fatal("alice's last attempt refused")
	}
	if l.Take("alice") {
		t.Fatal("alice's drained bucket was evicted and refilled")
	}
}

// A flood of throwaway keys must not evict a depleted bucket: that would
// restore the victim's burst and let an attacker reset its lockout at will.
func TestLoginLimiterFloodDoesNotResetLockout(t *testing.T) {
	clk := storetest.NewClock()
	l := auth.NewLoginLimiter(5, time.Minute, clk.Now)
	auth.SetMaxTrackedKeys(l, 10)
	for i := 0; i < 5; i++ {
		if !l.Take("victim") {
			t.Fatalf("attempt %d refused", i)
		}
	}
	for round := 0; round < 3; round++ {
		for i := 0; i < 10; i++ {
			l.Take(fmt.Sprintf("flood-%d-%d", round, i))
		}
		if l.Take("victim") {
			t.Fatalf("round %d: flood of new keys restored the victim's tokens", round)
		}
		if n := auth.TrackedKeys(l); n > 10 {
			t.Fatalf("tracking %d keys, cap is 10", n)
		}
	}
}

// When every tracked bucket is still restricting, a new key is refused
// rather than evicting one of them.
func TestLoginLimiterRefusesNewKeyWhenNoBucketCanBeEvicted(t *testing.T) {
	clk := storetest.NewClock()
	l := auth.NewLoginLimiter(1, time.Hour, clk.Now)
	auth.SetMaxTrackedKeys(l, 3)
	for _, k := range []string{"a", "b", "c"} {
		if !l.Take(k) {
			t.Fatalf("%s refused", k)
		}
	}
	if l.Take("d") {
		t.Fatal("new key admitted although every bucket is depleted")
	}
	if n := auth.TrackedKeys(l); n != 3 {
		t.Fatalf("tracking %d keys, want 3", n)
	}
	// Once the buckets have refilled they can be evicted again.
	clk.Advance(time.Hour)
	if !l.Take("d") {
		t.Fatal("new key refused after the tracked buckets refilled")
	}
	if n := auth.TrackedKeys(l); n != 3 {
		t.Fatalf("tracking %d keys, want 3", n)
	}
}

// Once the victim has refilled to burst its bucket is ordinary LRU fodder.
func TestLoginLimiterEvictsRefilledVictim(t *testing.T) {
	clk := storetest.NewClock()
	l := auth.NewLoginLimiter(2, time.Minute, clk.Now)
	auth.SetMaxTrackedKeys(l, 2)
	l.Take("victim")
	l.Take("victim")
	clk.Advance(2 * time.Minute) // victim refilled
	if !l.Take("x") {            // fills the second slot
		t.Fatal("x refused")
	}
	clk.Advance(2 * time.Minute) // x refilled too
	if !l.Take("y") {            // evicts victim, the LRU
		t.Fatal("y refused")
	}
	if n := auth.TrackedKeys(l); n != 2 {
		t.Fatalf("tracking %d keys, want 2", n)
	}
	if !auth.Tracks(l, "x") || !auth.Tracks(l, "y") || auth.Tracks(l, "victim") {
		t.Fatal("expected the refilled victim, the least recently used, to be evicted")
	}
}
