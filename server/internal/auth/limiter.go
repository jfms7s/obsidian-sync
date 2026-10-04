package auth

import (
	"math"
	"sync"
	"time"
)

// LoginLimiter is a token bucket per key (a lowercased username): Burst
// failed attempts, refilled at one attempt per Refill. Successes reset it.
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

func NewLoginLimiter(burst int, refill time.Duration, now func() time.Time) *LoginLimiter {
	return &LoginLimiter{burst: float64(burst), refill: refill, now: now, buckets: map[string]*bucket{}}
}

// refreshed returns key's bucket with tokens refilled up to now, or nil if
// the key has no failures on record. Caller holds mu.
func (l *LoginLimiter) refreshed(key string) *bucket {
	b, ok := l.buckets[key]
	if !ok {
		return nil
	}
	now := l.now()
	b.tokens = math.Min(l.burst, b.tokens+float64(now.Sub(b.last))/float64(l.refill))
	b.last = now
	return b
}

func (l *LoginLimiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.refreshed(key)
	return b == nil || b.tokens >= 1
}

func (l *LoginLimiter) Fail(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.refreshed(key)
	if b == nil {
		if len(l.buckets) >= maxTrackedKeys {
			l.evictFull()
		}
		b = &bucket{tokens: l.burst, last: l.now()}
		l.buckets[key] = b
	}
	b.tokens = math.Max(0, b.tokens-1)
}

func (l *LoginLimiter) Reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.buckets, key)
}

// evictFull forgets keys whose bucket has refilled completely. Caller holds mu.
func (l *LoginLimiter) evictFull() {
	now := l.now()
	for k, b := range l.buckets {
		if b.tokens+float64(now.Sub(b.last))/float64(l.refill) >= l.burst {
			delete(l.buckets, k)
		}
	}
}
