// Package clientip finds the address a request came from, trusting
// X-Forwarded-For only when it was written by a configured reverse proxy, and
// turns it into a rate-limit key.
package clientip

import (
	"net/http"
	"net/netip"
	"strings"
)

// Resolver resolves client addresses behind a set of trusted proxies.
type Resolver struct {
	trusted []netip.Prefix
}

// New returns a Resolver that trusts X-Forwarded-For only from peers inside
// one of trusted. With none, the TCP peer address is always the client.
func New(trusted []netip.Prefix) *Resolver {
	return &Resolver{trusted: trusted}
}

// Key returns the rate-limit key for r's client: an IPv4 address in full, an
// IPv6 address as its /56. One subscriber usually holds at least a /56 (often
// more), so keying by /64 would let a single actor mint 256 keys per /56 and
// fill the limiter's key table. If the
// peer address does not parse, it is used verbatim. untrustedXFF reports that
// r carried X-Forwarded-For that was ignored because the peer is not trusted,
// a hint that trusted_proxies may be misconfigured.
func (res *Resolver) Key(r *http.Request) (key string, untrustedXFF bool) {
	key, _, untrustedXFF = res.Keys(r)
	return key, untrustedXFF
}

// Keys is Key that also returns an aggregate key: for an IPv6 client its /48,
// which holds 256 /56s, so that one actor holding many /56s can be limited
// as a whole; for any other address "", meaning none.
func (res *Resolver) Keys(r *http.Request) (key, aggregate string, untrustedXFF bool) {
	addr, ok := res.Addr(r)
	if !ok {
		return r.RemoteAddr, "", false
	}
	if !res.isTrusted(peer(r)) && len(r.Header.Values("X-Forwarded-For")) > 0 {
		untrustedXFF = true
	}
	if addr.Is6() {
		aggregate = netip.PrefixFrom(addr, ipv6AggregateBits).Masked().String()
	}
	return keyFor(addr), aggregate, untrustedXFF
}

// Addr returns r's client address. If the peer is a trusted proxy, it is the
// right-most X-Forwarded-For entry that is not itself a trusted proxy: every
// entry to its right was appended by a proxy we trust, while entries to its
// left were supplied by the client and may be forged. If every entry is
// trusted, the left-most one is used. An unparsable entry stops the walk at
// the last trusted hop. ok is false only if the peer address is unparsable.
func (res *Resolver) Addr(r *http.Request) (addr netip.Addr, ok bool) {
	addr = peer(r)
	if !addr.IsValid() {
		return addr, false
	}
	if !res.isTrusted(addr) {
		return addr, true
	}
	hops := r.Header.Values("X-Forwarded-For")
	for i := len(hops) - 1; i >= 0; i-- {
		entries := strings.Split(hops[i], ",")
		for j := len(entries) - 1; j >= 0; j-- {
			a, valid := parseHop(entries[j])
			if !valid {
				return addr, true
			}
			addr = a
			if !res.isTrusted(a) {
				return addr, true
			}
		}
	}
	return addr, true
}

func (res *Resolver) isTrusted(a netip.Addr) bool {
	for _, p := range res.trusted {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// peer parses r.RemoteAddr, returning the zero Addr if it does not parse.
func peer(r *http.Request) netip.Addr {
	if ap, err := netip.ParseAddrPort(r.RemoteAddr); err == nil {
		return normalize(ap.Addr())
	}
	if a, err := netip.ParseAddr(r.RemoteAddr); err == nil {
		return normalize(a)
	}
	return netip.Addr{}
}

// parseHop parses one X-Forwarded-For entry: a bare address, or (as some
// proxies write) an address with a port.
func parseHop(s string) (netip.Addr, bool) {
	s = strings.TrimSpace(s)
	if a, err := netip.ParseAddr(s); err == nil {
		return normalize(a), true
	}
	if ap, err := netip.ParseAddrPort(s); err == nil {
		return normalize(ap.Addr()), true
	}
	return netip.Addr{}, false
}

func normalize(a netip.Addr) netip.Addr { return a.Unmap().WithZone("") }

// ipv6KeyBits is the IPv6 prefix length that counts as one client;
// ipv6AggregateBits is the coarser prefix whose clients are also limited
// together.
const (
	ipv6KeyBits       = 56
	ipv6AggregateBits = 48
)

func keyFor(a netip.Addr) string {
	if a.Is6() {
		return netip.PrefixFrom(a, ipv6KeyBits).Masked().String()
	}
	return a.String()
}
