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
	IPRPS   float64
	IPBurst int
	// TrustedProxies are the reverse proxies whose X-Forwarded-For is used
	// to find the client address.
	TrustedProxies []netip.Prefix
	// MaxKeys caps each limiter's tracked keys; zero = ratelimit.DefaultMaxKeys.
	MaxKeys int
	Now     func() time.Time
}

// limiters holds the request limiters; a nil limiter is disabled.
type limiters struct {
	device *ratelimit.Limiter // key: device ID
	ip     *ratelimit.Limiter // key: client address; login and WebSocket upgrade
	// authFail is kept apart from ip so that logins and WebSocket reconnects
	// do not use up an address's allowance for bad bearer tokens.
	authFail *ratelimit.Limiter // key: client address; bad bearer tokens
	clients  *clientip.Resolver
	xffOnce  sync.Once
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
	return &limiters{
		device:   mk(rl.DeviceRPS, rl.DeviceBurst),
		ip:       mk(rl.IPRPS, rl.IPBurst),
		authFail: mk(rl.IPRPS, rl.IPBurst),
		clients:  clientip.New(rl.TrustedProxies),
	}
}

// clientKey returns r's client address key, warning once if a proxy seems to
// be in front of the server without being listed in trusted_proxies (every
// client would then share the proxy's limits).
func (h *handlers) clientKey(r *http.Request) string {
	key, untrustedXFF := h.limits.clients.Key(r)
	if untrustedXFF {
		h.limits.xffOnce.Do(func() {
			h.log.Warn("ignoring X-Forwarded-For from a peer not in trusted_proxies; "+
				"if obsync runs behind a reverse proxy, add it to trusted_proxies (OBSYNC_TRUSTED_PROXIES) "+
				"or all clients share its per-IP rate limits",
				"peer", r.RemoteAddr)
		})
	}
	return key
}

// ipLimited spends one of the client address's unauthenticated requests
// before next runs.
func (h *handlers) ipLimited(next http.Handler) http.Handler {
	if h.limits.ip == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ok, retry := h.limits.ip.Take(h.clientKey(r)); !ok {
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
