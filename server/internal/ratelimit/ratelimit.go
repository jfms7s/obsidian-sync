// Package ratelimit provides a keyed token-bucket limiter with bounded
// memory.
package ratelimit

import (
	"container/list"
	"math"
	"sync"
	"time"
)

// DefaultMaxKeys is the number of keys a Limiter tracks when Options.MaxKeys
// is zero. A bucket costs about 200 bytes, so a full limiter holds ~20 MB.
const DefaultMaxKeys = 100_000

// evictScan bounds how many buckets a new key looks at, from the least
// recently used end, for one it may evict; it keeps each Take O(1).
const evictScan = 8

// Limiter is a token bucket per key: Burst tokens, refilled at one token per
// Interval.
//
// At most MaxKeys buckets are tracked, in least-recently-used order. Once the
// limiter is full, a new key evicts the least recently used bucket that has
// refilled to Burst. A bucket that is still restricting is never evicted,
// since forgetting it would restore its burst: flooding throwaway keys would
// otherwise reset a victim's limit. If no bucket can be evicted the new key is
// refused, so under such a flood unknown keys fail closed while memory stays
// bounded.
type Limiter struct {
	mu       sync.Mutex
	burst    float64
	interval time.Duration
	now      func() time.Time
	buckets  map[string]*list.Element // value: *bucket
	lru      *list.List               // front: most recently used
	maxKeys  int
}

type bucket struct {
	key    string
	tokens float64
	last   time.Time
}

type Options struct {
	Burst    int           // at least 1
	Interval time.Duration // time to refill one token; positive
	MaxKeys  int           // zero = DefaultMaxKeys
	Now      func() time.Time
}

// New panics if Burst < 1 or Interval <= 0, either of which would disable or
// break limiting.
func New(o Options) *Limiter {
	if o.Burst < 1 || o.Interval <= 0 {
		panic("ratelimit: New needs Burst >= 1 and Interval > 0")
	}
	if o.MaxKeys <= 0 {
		o.MaxKeys = DefaultMaxKeys
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	return &Limiter{
		burst: float64(o.Burst), interval: o.Interval, now: o.Now,
		buckets: map[string]*list.Element{}, lru: list.New(), maxKeys: o.MaxKeys,
	}
}

// IntervalForRate converts a rate in tokens per second to the time one token
// takes to refill. rps must be positive.
func IntervalForRate(rps float64) time.Duration {
	return time.Duration(math.Round(float64(time.Second) / rps))
}

// RetryAfterSeconds rounds a wait up to whole seconds for a Retry-After
// header, never below 1.
func RetryAfterSeconds(d time.Duration) int {
	s := int(math.Ceil(d.Seconds()))
	if s < 1 {
		return 1
	}
	return s
}

// Take consumes one token for key and reports whether one was available. If
// not, it also returns how long until one will be. Checking and consuming
// happen under one lock, so concurrent callers can't all pass before any of
// them is counted.
func (l *Limiter) Take(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	var b *bucket
	if e, ok := l.buckets[key]; ok {
		l.lru.MoveToFront(e)
		b = e.Value.(*bucket)
	} else {
		if l.lru.Len() >= l.maxKeys && !l.evict(now) {
			// Every candidate is still restricting; the oldest one frees up
			// within at most Burst intervals, so suggest one interval.
			return false, l.interval
		}
		b = &bucket{key: key, tokens: l.burst, last: now}
		l.buckets[key] = l.lru.PushFront(b)
	}
	b.tokens = l.refilled(b, now)
	b.last = now
	if b.tokens < 1 {
		return false, l.wait(b.tokens)
	}
	b.tokens--
	return true, 0
}

// Wait reports how long until key has a token, zero if it has one now,
// without spending one or tracking a new key.
func (l *Limiter) Wait(key string) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	e, ok := l.buckets[key]
	if !ok {
		return 0
	}
	if tokens := l.refilled(e.Value.(*bucket), l.now()); tokens < 1 {
		return l.wait(tokens)
	}
	return 0
}

// Refund gives back one token taken from key, never above Burst, for a
// caller that took it but then refused the request for another reason. An
// untracked key is left alone.
func (l *Limiter) Refund(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	e, ok := l.buckets[key]
	if !ok {
		return
	}
	b := e.Value.(*bucket)
	now := l.now()
	b.tokens = math.Min(l.burst, l.refilled(b, now)+1)
	b.last = now
}

// Reset forgets key, restoring its full burst.
func (l *Limiter) Reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if e, ok := l.buckets[key]; ok {
		l.lru.Remove(e)
		delete(l.buckets, key)
	}
}

// Len reports how many keys are tracked.
func (l *Limiter) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}

// Contains reports whether key is tracked.
func (l *Limiter) Contains(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	_, ok := l.buckets[key]
	return ok
}

func (l *Limiter) refilled(b *bucket, now time.Time) float64 {
	return math.Min(l.burst, b.tokens+float64(now.Sub(b.last))/float64(l.interval))
}

// wait is how long a bucket holding tokens (< 1) takes to reach one token.
func (l *Limiter) wait(tokens float64) time.Duration {
	// Rounded to the nanosecond so float error cannot push an exact wait
	// (say 2s) over a whole second when it is rounded up for Retry-After.
	return time.Duration(math.Round((1 - tokens) * float64(l.interval)))
}

// evict removes the least recently used bucket that is full at now, scanning
// at most evictScan buckets from the back, and reports whether it found one.
func (l *Limiter) evict(now time.Time) bool {
	e := l.lru.Back()
	for i := 0; i < evictScan && e != nil; i, e = i+1, e.Prev() {
		b := e.Value.(*bucket)
		if l.refilled(b, now) >= l.burst {
			l.lru.Remove(e)
			delete(l.buckets, b.key)
			return true
		}
	}
	return false
}
