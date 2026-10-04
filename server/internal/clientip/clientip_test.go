package clientip_test

import (
	"net/http"
	"net/netip"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/clientip"
)

func req(remote string, xff ...string) *http.Request {
	r, _ := http.NewRequest("GET", "/", nil)
	r.RemoteAddr = remote
	for _, v := range xff {
		r.Header.Add("X-Forwarded-For", v)
	}
	return r
}

func TestResolve(t *testing.T) {
	trusted := []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8"), netip.MustParsePrefix("fd00::/8")}
	none := clientip.New(nil)
	proxied := clientip.New(trusted)
	for _, tc := range []struct {
		name        string
		res         *clientip.Resolver
		r           *http.Request
		want        string
		untrustedFF bool
	}{
		{"no proxies: RemoteAddr", none, req("203.0.113.5:1234"), "203.0.113.5", false},
		{"no proxies: XFF ignored", none, req("203.0.113.5:1234", "198.51.100.1"), "203.0.113.5", true},
		{"untrusted peer: XFF ignored", proxied, req("203.0.113.5:1234", "198.51.100.1"), "203.0.113.5", true},
		{"trusted peer, no XFF", proxied, req("10.0.0.2:80"), "10.0.0.2", false},
		{"trusted peer: client from XFF", proxied, req("10.0.0.2:80", "198.51.100.1"), "198.51.100.1", false},
		{"right-most untrusted wins over spoofed left", proxied, req("10.0.0.2:80", "1.2.3.4, 198.51.100.1, 10.1.1.1"), "198.51.100.1", false},
		{"multiple XFF headers form one list", proxied, req("10.0.0.2:80", "1.2.3.4", "198.51.100.1,10.1.1.1"), "198.51.100.1", false},
		{"all trusted: left-most", proxied, req("10.0.0.2:80", "10.9.9.9, 10.1.1.1"), "10.9.9.9", false},
		{"garbage beyond trusted hops stops the walk", proxied, req("10.0.0.2:80", "198.51.100.1, nonsense, 10.1.1.1"), "10.1.1.1", false},
		{"IPv6 client grouped by /64", none, req("[2001:db8:1:2:aaaa::1]:443"), "2001:db8:1:2::/64", false},
		{"IPv6 via trusted v6 proxy", proxied, req("[fd00::1]:80", "2001:db8:1:2:ffff::9"), "2001:db8:1:2::/64", false},
		{"IPv4-mapped IPv6 treated as IPv4", none, req("[::ffff:203.0.113.5]:1"), "203.0.113.5", false},
		{"XFF entry with port", proxied, req("10.0.0.2:80", "198.51.100.1:5555"), "198.51.100.1", false},
		{"XFF bracketed v6 with port", proxied, req("10.0.0.2:80", "[2001:db8::1]:5555"), "2001:db8::/64", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			key, untrustedFF := tc.res.Key(tc.r)
			if key != tc.want || untrustedFF != tc.untrustedFF {
				t.Fatalf("Key = %q, %v; want %q, %v", key, untrustedFF, tc.want, tc.untrustedFF)
			}
		})
	}
}

func TestUnparsableRemoteAddr(t *testing.T) {
	key, _ := clientip.New(nil).Key(req("pipe"))
	if key != "pipe" {
		t.Fatalf("key = %q", key)
	}
}
