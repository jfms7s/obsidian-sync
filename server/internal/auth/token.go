package auth

import (
	"crypto/sha256"
	"encoding/base64"

	"github.com/jfms7s/obsidian-sync/server/internal/ids"
)

// NewToken returns a device bearer token (256 random bits, base64url) and the
// SHA-256 hash that is all the server stores.
func NewToken() (string, []byte, error) {
	token := base64.RawURLEncoding.EncodeToString(ids.Bytes(32))
	return token, HashToken(token), nil
}

func HashToken(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}
