package auth

import (
	"container/list"
	"math"
	"sync"
	"time"
)

// LoginLimiter is a token bucket per key (a lowercased username): Burst
// attempts, refilled at one attempt per Refill. Every attempt takes a token
// before the password is checked; a successful login resets the bucket.
//
// At most maxKeys buckets are tracked, in least-recently-used order. Once the
// limiter is full, a new key evicts the least recently used bucket that has
// refilled to Burst, looking at no more than evictScan buckets from the LRU
// end. A bucket that is still restricting is never evicted, since forgetting
// it would restore its burst: flooding throwaway usernames would otherwise
// reset a victim's lockout. If no bucket can be evicted the new key is
// refused, so under such a flood unknown keys fail closed while memory stays
// bounded and each attempt costs O(1).
type LoginLimiter struct {
	mu      sync.Mutex
	burst   float64
	refill  time.Duration
	now     func() time.Time
	buckets map[string]*list.Element // value: *bucket
	lru     *list.List               // front: most recently used
	maxKeys int
}

type bucket struct {
	key    string
	tokens float64
	last   time.Time
}

const (
	maxTrackedKeys = 10000
	evictScan      = 8
)

// NewLoginLimiter panics if burst < 1 or refill <= 0, either of which would
// disable or break limiting.
func NewLoginLimiter(burst int, refill time.Duration, now func() time.Time) *LoginLimiter {
	if burst < 1 || refill <= 0 {
		panic("auth: NewLoginLimiter needs burst >= 1 and refill > 0")
	}
	return &LoginLimiter{
		burst: float64(burst), refill: refill, now: now,
		buckets: map[string]*list.Element{}, lru: list.New(), maxKeys: maxTrackedKeys,
	}
}

// Take consumes one attempt for key and reports whether one was available.
// Checking and consuming happen under one lock, so concurrent attempts can't
// all pass before any of them is counted.
func (l *LoginLimiter) Take(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	var b *bucket
	if e, ok := l.buckets[key]; ok {
		l.lru.MoveToFront(e)
		b = e.Value.(*bucket)
	} else {
		if l.lru.Len() >= l.maxKeys && !l.evict(now) {
			return false
		}
		b = &bucket{key: key, tokens: l.burst, last: now}
		l.buckets[key] = l.lru.PushFront(b)
	}
	b.tokens = math.Min(l.burst, b.tokens+float64(now.Sub(b.last))/float64(l.refill))
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// evict removes the least recently used bucket that is full at now, scanning
// at most evictScan buckets from the back, and reports whether it found one.
func (l *LoginLimiter) evict(now time.Time) bool {
	e := l.lru.Back()
	for i := 0; i < evictScan && e != nil; i, e = i+1, e.Prev() {
		b := e.Value.(*bucket)
		if b.tokens+float64(now.Sub(b.last))/float64(l.refill) >= l.burst {
			l.lru.Remove(e)
			delete(l.buckets, b.key)
			return true
		}
	}
	return false
}

// Reset forgets key, restoring its full burst.
func (l *LoginLimiter) Reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if e, ok := l.buckets[key]; ok {
		l.lru.Remove(e)
		delete(l.buckets, key)
	}
}
