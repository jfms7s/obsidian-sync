package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"fmt"
	"strings"
)

// Recovery codes stand in for a TOTP code, once each, when the
// authenticator is lost. Each is 10 characters of Crockford's base32
// alphabet (50 bits), shown as xxxxx-xxxxx. They are random, so a fast hash
// is enough to store them.
const (
	RecoveryCodeCount = 10
	recoveryCodeLen   = 10
	recoveryAlphabet  = "0123456789abcdefghjkmnpqrstvwxyz"
)

// NewRecoveryCodes returns RecoveryCodeCount codes as shown to the user and
// their hashes as stored.
func NewRecoveryCodes() (shown []string, hashes [][]byte, err error) {
	for len(shown) < RecoveryCodeCount {
		var raw [recoveryCodeLen]byte
		if _, err := rand.Read(raw[:]); err != nil {
			return nil, nil, fmt.Errorf("recovery codes: %w", err)
		}
		var b strings.Builder
		for _, c := range raw {
			b.WriteByte(recoveryAlphabet[c&31]) // 256 is a multiple of 32: no bias
		}
		code := b.String()
		shown = append(shown, code[:5]+"-"+code[5:])
		hashes = append(hashes, RecoveryCodeHash(code))
	}
	return shown, hashes, nil
}

// NormalizeRecoveryCode reads a code as a person types it: any case, with or
// without the dash or spaces, and i, l and o read as 1, 1 and 0. ok is false
// for anything that cannot be a recovery code.
func NormalizeRecoveryCode(s string) (string, bool) {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		switch r {
		case '-', ' ':
			continue
		case 'i', 'l':
			r = '1'
		case 'o':
			r = '0'
		}
		if r > 127 || !strings.ContainsRune(recoveryAlphabet, r) {
			return "", false
		}
		b.WriteRune(r)
	}
	if b.Len() != recoveryCodeLen {
		return "", false
	}
	return b.String(), true
}

// RecoveryCodeHash is what is stored for a normalized code.
func RecoveryCodeHash(normalized string) []byte {
	sum := sha256.Sum256([]byte("obsync-recovery-code:" + normalized))
	return sum[:]
}
