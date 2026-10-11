package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // G505: RFC 6238 TOTP is defined over HMAC-SHA1, the one variant every authenticator app supports
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// TOTP (RFC 6238) with the parameters every authenticator app supports:
// HMAC-SHA1, 6 digits, 30-second steps, 160-bit secrets.
const (
	totpPeriod      = 30 * time.Second
	totpDigits      = 6
	totpSecretBytes = 20
	// totpSkew is how many steps either side of the current one are accepted,
	// for clocks that are a little off.
	totpSkew = 1
)

var totpBase32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// TOTPStep is the time step t falls in.
func TOTPStep(t time.Time) int64 { return t.Unix() / int64(totpPeriod/time.Second) }

// TOTPCode is the code for secret at step (RFC 4226 HOTP with the step as
// the counter).
func TOTPCode(secret []byte, step int64) string {
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], uint64(step)) //nolint:gosec // G115: steps are positive for any time after 1970
	mac := hmac.New(sha1.New, secret)
	mac.Write(msg[:])
	sum := mac.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	bin := binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", bin%1_000_000)
}

// VerifyTOTP checks code against the steps around now and returns the step
// it matched. A step at or below lastStep (the last one accepted for this
// secret) is refused, so a code works once. Every candidate is compared, in
// constant time, whatever matches.
func VerifyTOTP(secret []byte, code string, now time.Time, lastStep int64) (int64, bool) {
	code = strings.ReplaceAll(code, " ", "")
	if !isTOTPCode(code) {
		return 0, false
	}
	cur := TOTPStep(now)
	var matched int64
	found := false
	for step := cur - totpSkew; step <= cur+totpSkew; step++ {
		eq := subtle.ConstantTimeCompare([]byte(TOTPCode(secret, step)), []byte(code)) == 1
		if eq && step > lastStep && !found {
			matched, found = step, true
		}
	}
	return matched, found
}

func isTOTPCode(s string) bool {
	if len(s) != totpDigits {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// NewTOTPSecret returns a random 160-bit secret.
func NewTOTPSecret() ([]byte, error) {
	s := make([]byte, totpSecretBytes)
	if _, err := rand.Read(s); err != nil {
		return nil, fmt.Errorf("totp secret: %w", err)
	}
	return s, nil
}

// TOTPSecretText is the secret as authenticator apps take it typed in:
// base32 without padding.
func TOTPSecretText(secret []byte) string { return totpBase32.EncodeToString(secret) }

// TOTPURI is the otpauth:// URI apps import (as a link or a QR code).
func TOTPURI(username string, secret []byte) string {
	q := url.Values{}
	q.Set("secret", TOTPSecretText(secret))
	q.Set("issuer", "obsync")
	q.Set("algorithm", "SHA1")
	q.Set("digits", fmt.Sprint(totpDigits))
	q.Set("period", fmt.Sprint(int(totpPeriod/time.Second)))
	return "otpauth://totp/obsync:" + url.PathEscape(username) + "?" + q.Encode()
}
