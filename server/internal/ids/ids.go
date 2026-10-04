// Package ids generates the random identifiers obsync uses.
package ids

import (
	"crypto/rand"
	"encoding/hex"
	"regexp"
)

var hexID = regexp.MustCompile(`^[0-9a-f]{32}$`)

// New returns 16 random bytes as 32 lowercase hex characters.
func New() string { return hex.EncodeToString(Bytes(16)) }

// Bytes returns n cryptographically random bytes.
func Bytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand failed: " + err.Error())
	}
	return b
}

// Valid reports whether id has the format New produces.
func Valid(id string) bool { return hexID.MatchString(id) }
