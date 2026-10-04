package api

import (
	"fmt"
	"net/http"
	"net/netip"
	"strconv"
	"sync"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/clientip"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
	"github.com/jfms7s/obsidian-sync/server/internal/ratelimit"
)

// RateLimits configures request rate limiting. The zero value disables it.
type RateLimits struct {
	// DeviceRPS and DeviceBurst bound each authenticated device's requests,
	// all routes sharing one bucket. A zero rate disables the limit.
	DeviceRPS   float64
	DeviceBurst int
	// IPRPS and IPBurst bound, per client address, unauthenticated requests
	// (login and the WebSocket upgrade) and, in a separate bucket, requests
	// with a missing or invalid bearer token. A zero rate disables both.
	// An IPv6 client is keyed by its /56 and its /48 is also limited, at
	// ipv6AggregateFactor times the rate and burst.
	IPRPS   float64
	IPBurst int
	// TrustedProxies are the reverse proxies whose X-Forwarded-For is used
	// to find the client address.
	TrustedProxies []netip.Prefix
	// MaxKeys caps each limiter's tracked keys; zero = ratelimit.DefaultMaxKeys.
	MaxKeys int
	Now     func() time.Time
}

// ipv6AggregateFactor scales the per-address rate and burst for the
// per-/48 aggregate bucket. A /48 holds 256 /56s, each a separate client
// key; without the aggregate one actor holding a /48 would get 256 times an
// address's budget (and could fill the limiter's key table that much faster).
// A few real clients sharing a /48 (one site, say) still have room.
const ipv6AggregateFactor = 4

// limiters holds the request limiters; a nil limiter is disabled.
type limiters struct {
	device *ratelimit.Limiter // key: device ID
	ip     *ipLimiter         // client address; login and WebSocket upgrade
	// authFail is kept apart from ip so that logins and WebSocket reconnects
	// do not use up an address's allowance for bad bearer tokens.
	authFail *ipLimiter // client address; bad bearer tokens
	clients  *clientip.Resolver
	xffOnce  sync.Once
}

// ipLimiter limits client addresses: one bucket per address key (an IPv4
// address or IPv6 /56) and, for IPv6, one per aggregate key (the /48).
type ipLimiter struct {
	addr, agg *ratelimit.Limiter
}

// take spends a token from the address's bucket and, if it has an aggregate
// key, from the aggregate's; a request passes only if both have one. A token
// taken from the address is refunded when the aggregate refuses, so traffic
// elsewhere in its /48 does not drain an address's own budget. On refusal it
// returns the longer of the two waits.
func (l *ipLimiter) take(key, aggregate string) (bool, time.Duration) {
	ok, wait := l.addr.Take(key)
	if aggregate == "" {
		return ok, wait
	}
	if !ok {
		return false, max(wait, l.agg.Wait(aggregate))
	}
	if ok, aggWait := l.agg.Take(aggregate); !ok {
		l.addr.Refund(key)
		return false, aggWait
	}
	return true, 0
}

func newLimiters(rl RateLimits) *limiters {
	mk := func(rps float64, burst int) *ratelimit.Limiter {
		if rps <= 0 {
			return nil
		}
		return ratelimit.New(ratelimit.Options{
			Burst: burst, Interval: ratelimit.IntervalForRate(rps), MaxKeys: rl.MaxKeys, Now: rl.Now,
		})
	}
	mkIP := func() *ipLimiter {
		if rl.IPRPS <= 0 {
			return nil
		}
		return &ipLimiter{
			addr: mk(rl.IPRPS, rl.IPBurst),
			agg:  mk(rl.IPRPS*ipv6AggregateFactor, rl.IPBurst*ipv6AggregateFactor),
		}
	}
	return &limiters{
		device:   mk(rl.DeviceRPS, rl.DeviceBurst),
		ip:       mkIP(),
		authFail: mkIP(),
		clients:  clientip.New(rl.TrustedProxies),
	}
}

// takeIP spends one of r's client address's requests from l (see
// ipLimiter.take).
func (h *handlers) takeIP(l *ipLimiter, r *http.Request) (bool, time.Duration) {
	key, aggregate := h.clientKeys(r)
	return l.take(key, aggregate)
}

// clientKeys returns r's client address key and aggregate key, warning once
// if a proxy seems to be in front of the server without being listed in
// trusted_proxies (every client would then share the proxy's limits).
func (h *handlers) clientKeys(r *http.Request) (key, aggregate string) {
	key, aggregate, untrustedXFF := h.limits.clients.Keys(r)
	if untrustedXFF {
		h.limits.xffOnce.Do(func() {
			h.log.Warn("ignoring X-Forwarded-For from a peer not in trusted_proxies; "+
				"if obsync runs behind a reverse proxy, add it to trusted_proxies (OBSYNC_TRUSTED_PROXIES) "+
				"or all clients share its per-IP rate limits",
				"peer", r.RemoteAddr)
		})
	}
	return key, aggregate
}

// ipLimited spends one of the client address's unauthenticated requests
// before next runs.
func (h *handlers) ipLimited(next http.Handler) http.Handler {
	if h.limits.ip == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ok, retry := h.takeIP(h.limits.ip, r); !ok {
			writeRateLimited(w, retry)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// writeRateLimited answers 429 RATE_LIMITED with Retry-After in whole
// seconds, rounded up.
func writeRateLimited(w http.ResponseWriter, retry time.Duration) {
	secs := ratelimit.RetryAfterSeconds(retry)
	w.Header().Set("Retry-After", strconv.Itoa(secs))
	writeProto(w, http.StatusTooManyRequests, &obsyncv1.Error{
		Code: apperr.RateLimited, Message: fmt.Sprintf("too many requests; retry in %d s", secs),
	})
}
