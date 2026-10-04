// Package blob stores encrypted chunk bytes under opaque keys.
package blob

import (
	"context"
	"errors"
	"io"
	"regexp"
)

var ErrNotFound = errors.New("blob: not found")

type Store interface {
	// Put stores r under key atomically; a failed Put leaves no blob behind.
	Put(ctx context.Context, key string, r io.Reader) error
	Get(ctx context.Context, key string) (io.ReadCloser, error)
	// Delete removes key; deleting a missing key is not an error.
	Delete(ctx context.Context, key string) error
	Ping(ctx context.Context) error
}

var validKey = regexp.MustCompile(`^[a-z0-9]+(/[a-z0-9]+)*$`)

// ValidKey reports whether key is safe to use as a relative path or object name.
func ValidKey(key string) bool { return validKey.MatchString(key) }
