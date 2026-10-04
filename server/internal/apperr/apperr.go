// Package apperr carries a protocol ErrorCode with an error, so every layer
// can say what went wrong in terms a client acts on.
package apperr

import (
	"errors"
	"fmt"

	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
)

const (
	Conflict      = obsyncv1.ErrorCode_ERROR_CODE_CONFLICT
	QuotaExceeded = obsyncv1.ErrorCode_ERROR_CODE_QUOTA_EXCEEDED
	Unauthorized  = obsyncv1.ErrorCode_ERROR_CODE_UNAUTHORIZED
	DeviceRevoked = obsyncv1.ErrorCode_ERROR_CODE_DEVICE_REVOKED
	StaleEpoch    = obsyncv1.ErrorCode_ERROR_CODE_STALE_EPOCH
	RateLimited   = obsyncv1.ErrorCode_ERROR_CODE_RATE_LIMITED
	TooLarge      = obsyncv1.ErrorCode_ERROR_CODE_TOO_LARGE
	NotFound      = obsyncv1.ErrorCode_ERROR_CODE_NOT_FOUND
	Internal      = obsyncv1.ErrorCode_ERROR_CODE_INTERNAL
	Invalid       = obsyncv1.ErrorCode_ERROR_CODE_INVALID
	MissingChunk  = obsyncv1.ErrorCode_ERROR_CODE_MISSING_CHUNK
	WrongPassword = obsyncv1.ErrorCode_ERROR_CODE_WRONG_PASSWORD
)

// Error is an error whose message is safe to show to the client.
type Error struct {
	Code obsyncv1.ErrorCode
	Msg  string
}

func (e *Error) Error() string { return e.Msg }

func New(code obsyncv1.ErrorCode, format string, args ...any) *Error {
	return &Error{Code: code, Msg: fmt.Sprintf(format, args...)}
}

// CodeOf returns the code of the first *Error in err's chain, or Internal.
func CodeOf(err error) obsyncv1.ErrorCode {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return Internal
}
