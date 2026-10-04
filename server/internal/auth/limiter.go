package auth

import (
	"math"
	"sync"
	"time"
)

// LoginLimiter is a token bucket per key (a lowercased username): Burst
// attempts, refilled at one attempt per Refill. Every attempt takes a token
// before the password is checked; a successful login resets the bucket.
type LoginLimiter struct {
	mu      sync.Mutex
	burst   float64
	refill  time.Duration
	now     func() time.Time
	buckets map[string]*bucket
}

type bucket struct {
	tokens float64
	last   time.Time
}

const maxTrackedKeys = 10000

// NewLoginLimiter panics if burst < 1 or refill <= 0, either of which would
// disable or break limiting.
func NewLoginLimiter(burst int, refill time.Duration, now func() time.Time) *LoginLimiter {
	if burst < 1 || refill <= 0 {
		panic("auth: NewLoginLimiter needs burst >= 1 and refill > 0")
	}
	return &LoginLimiter{burst: float64(burst), refill: refill, now: now, buckets: map[string]*bucket{}}
}

// Take consumes one attempt for key and reports whether one was available.
// Checking and consuming happen under one lock, so concurrent attempts can't
// all pass before any of them is counted.
func (l *LoginLimiter) Take(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	b, ok := l.buckets[key]
	if !ok {
		if len(l.buckets) >= maxTrackedKeys {
			l.evictFull(now)
		}
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	b.tokens = math.Min(l.burst, b.tokens+float64(now.Sub(b.last))/float64(l.refill))
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// Reset forgets key, restoring its full burst.
func (l *LoginLimiter) Reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.buckets, key)
}

// evictFull forgets keys whose bucket has refilled completely. Caller holds mu.
func (l *LoginLimiter) evictFull(now time.Time) {
	for k, b := range l.buckets {
		if b.tokens+float64(now.Sub(b.last))/float64(l.refill) >= l.burst {
			delete(l.buckets, k)
		}
	}
}
