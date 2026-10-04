package auth

import (
	"crypto/sha256"
	"encoding/base64"

	"github.com/jfms7s/obsidian-sync/server/internal/ids"
)

// NewToken returns a device bearer token (256 random bits, base64url) and the
// SHA-256 hash that is all the server stores.
func NewToken() (string, []byte, error) {
	token := base64.RawURLEncoding.EncodeToString(ids.Bytes(tokenBytes))
	return token, HashToken(token), nil
}

func HashToken(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}

// tokenBytes is the size of a device token's random value; tokenLen is the
// length of its unpadded base64url encoding.
const (
	tokenBytes = 32
	tokenLen   = (tokenBytes*8 + 5) / 6 // 43
)

// WellFormedToken reports whether token could have been issued by NewToken:
// exactly 43 characters of the base64url alphabet, unpadded, decoding to 32
// bytes with the 2 unused trailing bits zero (so the last character is one of
// 16 possible). Anything else can be refused without looking it up.
func WellFormedToken(token string) bool {
	if len(token) != tokenLen {
		return false
	}
	var buf [tokenBytes + 1]byte // room to notice an over-long decode
	n, err := base64.RawURLEncoding.Strict().Decode(buf[:], []byte(token))
	return err == nil && n == tokenBytes
}
