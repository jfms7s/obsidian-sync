package store

import (
	"errors"
	"net/url"
	"strings"
	"testing"
)

func TestURLSecretsCoverUserinfoAndSecretParams(t *testing.T) {
	u, err := url.Parse("libsql://al%40ice:p%40ss+w@db.example.com/?authToken=t%2Bok&remoteEncryptionKey=k1&API_SECRET=s1&dbPassword=p1&MyToken=t2&region=eu-west")
	if err != nil {
		t.Fatal(err)
	}
	r := urlSecrets(u)
	msg := "al@ice al%40ice p@ss+w p%40ss+w t+ok t%2Bok k1 s1 p1 t2 region=eu-west"
	got := r.err(errors.New(msg)).Error()
	for _, s := range []string{"al@ice", "al%40ice", "p@ss+w", "p%40ss+w", "t+ok", "t%2Bok", "k1", "s1", "p1", "t2"} {
		if strings.Contains(got, s) {
			t.Fatalf("%q survives redaction: %q", s, got)
		}
	}
	if !strings.Contains(got, "region=eu-west") {
		t.Fatalf("a non-secret parameter was redacted: %q", got)
	}
}
