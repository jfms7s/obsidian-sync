package ratelimit_test

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/ratelimit"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
)

func newLimiter(clk *storetest.Clock, burst int, interval time.Duration, maxKeys int) *ratelimit.Limiter {
	return ratelimit.New(ratelimit.Options{Burst: burst, Interval: interval, MaxKeys: maxKeys, Now: clk.Now})
}

func TestTakeAndRetryAfter(t *testing.T) {
	clk := storetest.NewClock()
	l := newLimiter(clk, 2, 3*time.Second, 0)
	for i := 0; i < 2; i++ {
		if ok, _ := l.Take("a"); !ok {
			t.Fatalf("take %d refused", i)
		}
	}
	ok, retry := l.Take("a")
	if ok || retry != 3*time.Second {
		t.Fatalf("got %v %v, want refusal with 3s retry", ok, retry)
	}
	clk.Advance(time.Second)
	if ok, retry := l.Take("a"); ok || retry != 2*time.Second {
		t.Fatalf("got %v %v, want refusal with 2s retry", ok, retry)
	}
	clk.Advance(2 * time.Second)
	if ok, _ := l.Take("a"); !ok {
		t.Fatal("no refill")
	}
	if ok, _ := l.Take("b"); !ok {
		t.Fatal("keys share a bucket")
	}
}

func TestRetryAfterSeconds(t *testing.T) {
	for _, tc := range []struct {
		d    time.Duration
		want int
	}{{0, 1}, {time.Millisecond, 1}, {time.Second, 1}, {1001 * time.Millisecond, 2}, {50 * time.Second, 50}} {
		if got := ratelimit.RetryAfterSeconds(tc.d); got != tc.want {
			t.Errorf("RetryAfterSeconds(%v) = %d, want %d", tc.d, got, tc.want)
		}
	}
}

func TestIntervalForRate(t *testing.T) {
	if got := ratelimit.IntervalForRate(20); got != 50*time.Millisecond {
		t.Errorf("20 rps = %v", got)
	}
	if got := ratelimit.IntervalForRate(0.5); got != 2*time.Second {
		t.Errorf("0.5 rps = %v", got)
	}
}

// Delay reports the wait without spending a token or tracking a new key.
func TestDelayDoesNotConsume(t *testing.T) {
	clk := storetest.NewClock()
	l := newLimiter(clk, 1, time.Minute, 0)
	if d := l.Delay("a"); d != 0 {
		t.Fatalf("Delay on unknown key = %v", d)
	}
	if l.Len() != 0 {
		t.Fatal("Delay tracked a new key")
	}
	l.Take("a")
	if d := l.Delay("a"); d != time.Minute {
		t.Fatalf("Delay on drained key = %v", d)
	}
	clk.Advance(time.Minute)
	if d := l.Delay("a"); d != 0 {
		t.Fatalf("Delay after refill = %v", d)
	}
	if ok, _ := l.Take("a"); !ok {
		t.Fatal("Delay consumed a token")
	}
}

func TestTakeIsAtomic(t *testing.T) {
	l := ratelimit.New(ratelimit.Options{Burst: 5, Interval: time.Hour})
	var granted atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if ok, _ := l.Take("k"); ok {
				granted.Add(1)
			}
		}()
	}
	wg.Wait()
	if n := granted.Load(); n != 5 {
		t.Fatalf("granted %d, want 5", n)
	}
}

func TestNewRejectsBadSettings(t *testing.T) {
	for _, o := range []ratelimit.Options{{Burst: 0, Interval: time.Second}, {Burst: 1}, {Burst: 1, Interval: -1}} {
		func() {
			defer func() {
				if recover() == nil {
					t.Errorf("%+v: no panic", o)
				}
			}()
			ratelimit.New(o)
		}()
	}
}

func TestDefaultMaxKeys(t *testing.T) {
	if ratelimit.DefaultMaxKeys != 100_000 {
		t.Fatalf("DefaultMaxKeys = %d", ratelimit.DefaultMaxKeys)
	}
}

func TestBounded(t *testing.T) {
	clk := storetest.NewClock()
	l := newLimiter(clk, 3, time.Hour, 100)
	for i := 0; i < 1000; i++ {
		l.Take(fmt.Sprintf("k%d", i))
		if n := l.Len(); n > 100 {
			t.Fatalf("tracking %d keys, cap 100", n)
		}
	}
}

// A restricting bucket is never evicted; a new key is refused instead, with
// a positive retry hint.
func TestNeverEvictsRestrictingBucket(t *testing.T) {
	clk := storetest.NewClock()
	l := newLimiter(clk, 2, time.Minute, 3)
	l.Take("victim")
	l.Take("victim")
	for _, k := range []string{"x", "y"} {
		l.Take(k)
	}
	ok, retry := l.Take("new")
	if ok || retry <= 0 {
		t.Fatalf("new key: %v %v, want refusal with retry", ok, retry)
	}
	if !l.Contains("victim") || l.Len() != 3 {
		t.Fatal("restricting bucket evicted")
	}
	if ok, _ := l.Take("victim"); ok {
		t.Fatal("victim's bucket was reset")
	}
	// Once x and y refill (victim needs longer) the LRU full bucket goes.
	clk.Advance(time.Minute)
	l.Take("victim") // victim back to 0, most recent
	if ok, _ := l.Take("new"); !ok {
		t.Fatal("new key refused although x had refilled")
	}
	if l.Contains("x") || !l.Contains("victim") || !l.Contains("y") {
		t.Fatal("expected x, the LRU full bucket, to be evicted")
	}
}

func TestReset(t *testing.T) {
	clk := storetest.NewClock()
	l := newLimiter(clk, 1, time.Hour, 0)
	l.Take("a")
	l.Reset("a")
	if l.Contains("a") {
		t.Fatal("still tracked")
	}
	if ok, _ := l.Take("a"); !ok {
		t.Fatal("reset did not restore burst")
	}
}
