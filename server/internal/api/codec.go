package api

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"slices"
	"time"

	"google.golang.org/protobuf/proto"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
)

const protoContentType = "application/x-protobuf"

// Request body limits, chosen per route so that unauthenticated routes cannot
// be made to buffer large bodies. Every caller of readProto passes one.
const (
	// loginBodyLimit bounds POST /v1/auth/login (unauthenticated).
	loginBodyLimit int64 = 16 << 10
	// smallBodyLimit bounds small authenticated requests: PUT /v1/keys,
	// device management, vault creation.
	smallBodyLimit int64 = 64 << 10
	// chunkListBodyLimit bounds requests that list chunk IDs (32 bytes plus
	// framing each), such as POST …/chunks/exists.
	chunkListBodyLimit int64 = 1 << 20
	// commitBodyLimit bounds commit batches, the largest protobuf request.
	commitBodyLimit int64 = 8 << 20
)

// Body read deadlines bound how long a client may take to send a request
// body, so a slow or stalled sender cannot hold a connection and a handler
// goroutine indefinitely. Variables so tests can shorten them.
var (
	// protoBodyTimeout bounds every protobuf request body (readProto).
	protoBodyTimeout = 30 * time.Second
	// chunkBodyTimeout bounds a chunk upload (up to 4 MiB) on a slow link.
	chunkBodyTimeout = 5 * time.Minute
	// chunkWriteTimeout bounds sending a chunk download, so a client that
	// stops reading cannot hold the connection and handler forever.
	chunkWriteTimeout = 5 * time.Minute
)

// unmarshalOpts drops unknown fields so a client cannot smuggle extra bytes
// past field-level size checks into anything the server re-marshals.
var unmarshalOpts = proto.UnmarshalOptions{DiscardUnknown: true}

// errUnsupportedMediaType is answered with 415 rather than statusFor's 400.
var errUnsupportedMediaType = apperr.New(apperr.Invalid, "unsupported Content-Type")

// requireMediaType rejects a request whose Content-Type (ignoring parameters
// such as charset) is not one of allowed. An allowed "" accepts a request
// without the header.
func requireMediaType(r *http.Request, allowed ...string) error {
	ct := r.Header.Get("Content-Type")
	mt := ""
	if ct != "" {
		var err error
		if mt, _, err = mime.ParseMediaType(ct); err != nil {
			return errUnsupportedMediaType
		}
	}
	if slices.Contains(allowed, mt) {
		return nil
	}
	return errUnsupportedMediaType
}

// readProto decodes a request body of at most limit bytes into m. The body
// must be labelled application/x-protobuf.
func readProto(w http.ResponseWriter, r *http.Request, m proto.Message, limit int64) error {
	// Set the deadline before any early rejection: net/http drains a small
	// unread body before sending the response, and that drain must be bounded.
	lift := setBodyDeadline(w, protoBodyTimeout)
	if err := requireMediaType(r, protoContentType); err != nil {
		return err
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return apperr.New(apperr.TooLarge, "request body exceeds %d bytes", limit)
		}
		return apperr.New(apperr.Invalid, "could not read the request body")
	}
	lift()
	if err := unmarshalOpts.Unmarshal(body, m); err != nil {
		return apperr.New(apperr.Invalid, "request body is not a valid %s", m.ProtoReflect().Descriptor().Name())
	}
	return nil
}

// setBodyDeadline limits how long reading the request body may take. Call
// the returned lift once the whole body has been read: net/http keeps reading
// the connection in the background while the handler runs, and a deadline
// expiring there would cancel the request's context. After a failed read,
// leave the deadline in place: net/http then cannot wait for the rest of a
// stalled body after the handler returns, and closes the connection instead.
// Writers that cannot set deadlines (http.ErrNotSupported, e.g. some test
// recorders) are left unbounded.
func setBodyDeadline(w http.ResponseWriter, d time.Duration) (lift func()) {
	rc := http.NewResponseController(w)
	if err := rc.SetReadDeadline(time.Now().Add(d)); err != nil {
		return func() {}
	}
	return func() { _ = rc.SetReadDeadline(time.Time{}) }
}

// writeProto sends m with status. Responses carry user data, so they must not
// be cached or content-sniffed.
func writeProto(w http.ResponseWriter, status int, m proto.Message) {
	data, err := proto.Marshal(m)
	if err != nil {
		if tw, ok := w.(*trackingWriter); ok && tw.log != nil {
			tw.log.Error("encode response", "type", string(m.ProtoReflect().Descriptor().FullName()), "err", err)
		}
		status = http.StatusInternalServerError
		data, _ = proto.Marshal(&obsyncv1.Error{Code: apperr.Internal, Message: "internal error"})
	}
	hdr := w.Header()
	hdr.Set("Content-Type", protoContentType)
	hdr.Set("Cache-Control", "no-store")
	hdr.Set("X-Content-Type-Options", "nosniff")
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
	status := statusFor(ae.Code)
	if ae == errUnsupportedMediaType {
		status = http.StatusUnsupportedMediaType
	}
	writeProto(w, status, &obsyncv1.Error{Code: ae.Code, Message: ae.Msg})
}
