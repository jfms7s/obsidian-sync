// Package limits holds the protocol limits that clients mirror
// (plugin/src/api/limits.ts and ARGON2_LIMITS in plugin/src/crypto/userkeys.ts).
// cmd/vectorgen writes them to plugin/test/vectors/limits.json and a plugin
// test compares the two, so a change here that the plugin does not follow
// fails CI. The package has no dependencies, so vectorgen stays free of CGO.
package limits

const (
	// ChunkSize is the size of every chunk but a file's last.
	ChunkSize = 4 << 20
	// MaxCommitsPerRequest bounds one commit batch.
	MaxCommitsPerRequest = 500
	// CommitBodyLimit bounds a commit batch's request body, the largest protobuf request.
	CommitBodyLimit int64 = 8 << 20
	// MaxEncMetaBytes bounds one version's encrypted metadata.
	MaxEncMetaBytes = 64 << 10
	// MaxChunkExistsBatch bounds the chunk ids of one exists check.
	MaxChunkExistsBatch = 1000
	// MaxPageSize bounds a page of the change log.
	MaxPageSize = 1000
	// MaxHeadsPageSize bounds a page of heads.
	MaxHeadsPageSize = 5000
	// MaxPasswordBytes bounds the input to a password check.
	MaxPasswordBytes = 1024
	// LoginBodyLimit bounds POST /v1/auth/login (unauthenticated).
	LoginBodyLimit int64 = 16 << 10

	// Argon2 parameter bounds for a key bundle's passphrase. Clients run
	// whatever is stored, so an absurd value would lock the user out of
	// every device, and a weak one would make the passphrase cheap to guess.
	MinArgon2MemoryKib   = 8192
	MaxArgon2MemoryKib   = 4 << 20 // 4 GiB
	MaxArgon2Iterations  = 64
	MaxArgon2Parallelism = 16
)
