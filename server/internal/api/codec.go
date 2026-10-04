package api

import (
	"errors"
	"io"
	"net/http"

	"google.golang.org/protobuf/proto"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
)

const (
	protoContentType  = "application/x-protobuf"
	maxProtoBodyBytes = 8 << 20
)

func readProto(w http.ResponseWriter, r *http.Request, m proto.Message) error {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxProtoBodyBytes))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return apperr.New(apperr.TooLarge, "request body exceeds %d bytes", maxProtoBodyBytes)
		}
		return apperr.New(apperr.Invalid, "could not read the request body")
	}
	if err := proto.Unmarshal(body, m); err != nil {
		return apperr.New(apperr.Invalid, "request body is not a valid %s", m.ProtoReflect().Descriptor().Name())
	}
	return nil
}

func writeProto(w http.ResponseWriter, status int, m proto.Message) {
	data, err := proto.Marshal(m)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", protoContentType)
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

func statusFor(code obsyncv1.ErrorCode) int {
	switch code {
	case apperr.Invalid, apperr.MissingChunk:
		return http.StatusBadRequest
	case apperr.Unauthorized, apperr.DeviceRevoked:
		return http.StatusUnauthorized
	case apperr.NotFound:
		return http.StatusNotFound
	case apperr.Conflict, apperr.StaleEpoch:
		return http.StatusConflict
	case apperr.TooLarge:
		return http.StatusRequestEntityTooLarge
	case apperr.RateLimited:
		return http.StatusTooManyRequests
	case apperr.QuotaExceeded:
		return http.StatusInsufficientStorage
	default:
		return http.StatusInternalServerError
	}
}

// writeError sends err to the client. Errors that are not *apperr.Error are
// infrastructure failures: they are logged and the client sees only INTERNAL.
func (h *handlers) writeError(w http.ResponseWriter, r *http.Request, err error) {
	var ae *apperr.Error
	if !errors.As(err, &ae) {
		h.log.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
		ae = apperr.New(apperr.Internal, "internal error")
	}
	writeProto(w, statusFor(ae.Code), &obsyncv1.Error{Code: ae.Code, Message: ae.Msg})
}
