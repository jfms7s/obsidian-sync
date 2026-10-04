package store

import (
	"errors"
	"strings"
)

var (
	ErrNotFound    = errors.New("store: not found")
	ErrExists      = errors.New("store: already exists")
	ErrKeyMismatch = errors.New("store: public keys differ from the stored key bundle")
	// ErrInvalid means the caller passed data the store refuses to record,
	// such as a malformed public key or a repeated vault key epoch. The API
	// validates requests first, so reaching it is a caller bug.
	ErrInvalid = errors.New("store: invalid input")
	// ErrQuotaExceeded is returned by InsertChunk when a new chunk would take
	// the vault owner's usage past their quota.
	ErrQuotaExceeded = errors.New("store: storage quota exceeded")
)

func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}

// nonNil keeps the stored value an empty blob whatever the driver does with nil.
func nonNil(b []byte) []byte {
	if b == nil {
		return []byte{}
	}
	return b
}

func boolInt(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

type rowScanner interface {
	Scan(dest ...any) error
}
