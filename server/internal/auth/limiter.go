package auth

import (
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/ratelimit"
)

// LoginLimiter is a token bucket per key (a lowercased username): Burst
// attempts, refilled at one attempt per Refill. Every attempt takes a token
// before the password is checked; a successful login resets the bucket.
//
// At most maxTrackedKeys buckets are tracked; see ratelimit.Limiter for how
// the cap is kept without ever evicting a bucket that is still restricting
// (flooding throwaway usernames must not reset a victim's lockout). If no
// bucket can be evicted a new key is refused, so under such a flood unknown
// keys fail closed.
type LoginLimiter struct {
	l *ratelimit.Limiter

	// kept so tests can rebuild l with a lower cap
	burst  int
	refill time.Duration
	now    func() time.Time
}

const maxTrackedKeys = 10000

// NewLoginLimiter panics if burst < 1 or refill <= 0, either of which would
// disable or break limiting.
func NewLoginLimiter(burst int, refill time.Duration, now func() time.Time) *LoginLimiter {
	if burst < 1 || refill <= 0 {
		panic("auth: NewLoginLimiter needs burst >= 1 and refill > 0")
	}
	ll := &LoginLimiter{burst: burst, refill: refill, now: now}
	ll.l = ll.newLimiter(maxTrackedKeys)
	return ll
}

func (ll *LoginLimiter) newLimiter(maxKeys int) *ratelimit.Limiter {
	return ratelimit.New(ratelimit.Options{Burst: ll.burst, Interval: ll.refill, MaxKeys: maxKeys, Now: ll.now})
}

// Take consumes one attempt for key and reports whether one was available.
// Checking and consuming happen under one lock, so concurrent attempts can't
// all pass before any of them is counted.
func (ll *LoginLimiter) Take(key string) bool {
	ok, _ := ll.l.Take(key)
	return ok
}

// Reset forgets key, restoring its full burst.
func (ll *LoginLimiter) Reset(key string) { ll.l.Reset(key) }
