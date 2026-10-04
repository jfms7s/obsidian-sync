package auth

import (
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"golang.org/x/crypto/argon2"

	"github.com/jfms7s/obsidian-sync/server/internal/ids"
)

// Params are argon2id costs. Memory is in KiB.
type Params struct {
	Memory      uint32
	Iterations  uint32
	Parallelism uint8
	SaltLen     uint32
	KeyLen      uint32
}

// DefaultParams follow OWASP's argon2id guidance with headroom (64 MiB, t=2).
var DefaultParams = Params{Memory: 64 * 1024, Iterations: 2, Parallelism: 2, SaltLen: 16, KeyLen: 32}

// FastParams are for tests only; never use them for real accounts.
var FastParams = Params{Memory: 1024, Iterations: 1, Parallelism: 1, SaltLen: 16, KeyLen: 32}

var (
	errMalformedHash = errors.New("malformed password hash")
	errBadParams     = errors.New("argon2id parameters out of range")
)

// Bounds on the costs a hash may carry. A stored hash outside them is treated
// as corrupt rather than run, so a bad row can't panic argon2 or make it
// allocate without limit.
const (
	minIterations  = 1
	maxIterations  = 10
	minParallelism = 1
	maxParallelism = 16
	maxMemoryKiB   = 1 << 20 // 1 GiB
	minSaltLen     = 8
	maxSaltLen     = 64
	minKeyLen      = 16
	maxKeyLen      = 64
)

func (p Params) validate() error {
	switch {
	case p.Iterations < minIterations || p.Iterations > maxIterations,
		p.Parallelism < minParallelism || p.Parallelism > maxParallelism,
		p.Memory < 8*uint32(p.Parallelism) || p.Memory > maxMemoryKiB,
		p.SaltLen < minSaltLen || p.SaltLen > maxSaltLen,
		p.KeyLen < minKeyLen || p.KeyLen > maxKeyLen:
		return errBadParams
	}
	return nil
}

// HashPassword returns a PHC-format argon2id hash. It refuses parameters that
// VerifyPassword would not accept back.
func HashPassword(password string, p Params) (string, error) {
	if err := p.validate(); err != nil {
		return "", err
	}
	salt := ids.Bytes(int(p.SaltLen))
	key := argon2.IDKey([]byte(password), salt, p.Iterations, p.Memory, p.Parallelism, p.KeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, p.Memory, p.Iterations, p.Parallelism,
		b64.EncodeToString(salt), b64.EncodeToString(key)), nil
}

var b64 = base64.RawStdEncoding.Strict()

// VerifyPassword checks password against a hash from HashPassword, using the
// costs recorded in the hash. A hash that does not parse strictly, or whose
// costs are out of range, is an error.
func VerifyPassword(password, encoded string) (bool, error) {
	p, salt, want, err := parseHash(encoded)
	if err != nil {
		return false, err
	}
	got := argon2.IDKey([]byte(password), salt, p.Iterations, p.Memory, p.Parallelism, p.KeyLen)
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

func parseHash(encoded string) (p Params, salt, key []byte, err error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" {
		return p, nil, nil, errMalformedHash
	}
	version, ok := field(parts[2], "v", 32)
	if !ok || version != argon2.Version {
		return p, nil, nil, errMalformedHash
	}
	costs := strings.Split(parts[3], ",")
	if len(costs) != 3 {
		return p, nil, nil, errMalformedHash
	}
	m, okM := field(costs[0], "m", 32)
	t, okT := field(costs[1], "t", 32)
	par, okP := field(costs[2], "p", 8)
	if !okM || !okT || !okP {
		return p, nil, nil, errMalformedHash
	}
	if salt, err = decode(parts[4]); err != nil {
		return p, nil, nil, err
	}
	if key, err = decode(parts[5]); err != nil {
		return p, nil, nil, err
	}
	p = Params{Memory: uint32(m), Iterations: uint32(t), Parallelism: uint8(par),
		SaltLen: uint32(len(salt)), KeyLen: uint32(len(key))}
	if p.validate() != nil {
		return p, nil, nil, errMalformedHash
	}
	return p, salt, key, nil
}

// field parses "name=<decimal>" exactly, with no sign or trailing text.
func field(s, name string, bits int) (uint64, bool) {
	digits, ok := strings.CutPrefix(s, name+"=")
	if !ok || digits == "" || strings.TrimLeft(digits, "0123456789") != "" {
		return 0, false
	}
	n, err := strconv.ParseUint(digits, 10, bits)
	return n, err == nil
}

// decode reads unpadded standard base64, rejecting anything (such as embedded
// newlines, which the decoder would skip) that does not re-encode identically.
func decode(s string) ([]byte, error) {
	b, err := b64.DecodeString(s)
	if err != nil || b64.EncodeToString(b) != s {
		return nil, errMalformedHash
	}
	return b, nil
}
