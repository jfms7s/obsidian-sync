package api

import (
	"encoding/hex"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/syncsvc"
)

// hexID decodes 64 lowercase hex characters into 32 bytes. Uppercase is
// rejected so each ID has exactly one spelling.
func hexID(s, name string) ([]byte, error) {
	b, err := hex.DecodeString(s)
	if err != nil || len(b) != 32 || s != strings.ToLower(s) {
		return nil, apperr.New(apperr.Invalid, "%s must be 64 lowercase hex characters", name)
	}
	return b, nil
}

// pathID decodes a 64-lowercase-hex-character path segment into 32 bytes.
func pathID(r *http.Request, name string) ([]byte, error) {
	return hexID(r.PathValue(name), name)
}

// queryInt reads an optional non-negative integer query parameter (0 if absent).
func queryInt(r *http.Request, name string) (int64, error) {
	s := r.URL.Query().Get(name)
	if s == "" {
		return 0, nil
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n < 0 {
		return 0, apperr.New(apperr.Invalid, "%s must be a non-negative integer", name)
	}
	return n, nil
}

func (h *handlers) chunksExist(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	var req obsyncv1.ChunkExistsRequest
	if err := readProto(w, r, &req, chunkListBodyLimit); err != nil {
		h.writeError(w, r, err)
		return
	}
	exists, err := h.sync.ChunksExist(r.Context(), sess.UserID, r.PathValue("vault"), req.ChunkIds)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeProto(w, http.StatusOK, &obsyncv1.ChunkExistsResponse{Exists: exists})
}

func (h *handlers) putChunk(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	// Set the deadline before any early rejection: net/http drains a small
	// unread body before sending the response, and that drain must be bounded.
	lift := setBodyDeadline(w, chunkBodyTimeout)
	id, err := pathID(r, "chunk")
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	if err := requireMediaType(r, "application/octet-stream", ""); err != nil {
		h.writeError(w, r, err)
		return
	}
	if r.ContentLength < 0 {
		h.writeError(w, r, apperr.New(apperr.Invalid, "Content-Length is required"))
		return
	}
	body := http.MaxBytesReader(w, r.Body, syncsvc.MaxChunkCipherBytes+1)
	if err := h.sync.PutChunk(r.Context(), sess.UserID, r.PathValue("vault"), id, body, r.ContentLength); err != nil {
		// Keep the deadline: an unread or stalled body must not hold the
		// connection open after the error response.
		h.writeError(w, r, err)
		return
	}
	lift()
	w.WriteHeader(http.StatusNoContent)
}

func (h *handlers) getChunk(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	id, err := pathID(r, "chunk")
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	rc, size, err := h.sync.OpenChunk(r.Context(), sess.UserID, r.PathValue("vault"), id)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	defer rc.Close()
	hdr := w.Header()
	hdr.Set("Content-Type", "application/octet-stream")
	hdr.Set("Content-Length", strconv.FormatInt(size, 10))
	hdr.Set("Cache-Control", "no-store")
	hdr.Set("X-Content-Type-Options", "nosniff")
	// Bound the download so a client that stops reading cannot hold the
	// connection and this handler forever. Writers that cannot set deadlines
	// (http.ErrNotSupported) are left unbounded. net/http flushes the tail
	// under this deadline and clears it before the connection's next request.
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(chunkWriteTimeout))
	w.WriteHeader(http.StatusOK)
	src := &readErrReader{r: rc}
	n, err := io.Copy(w, src)
	switch {
	case src.err != nil:
		h.log.Error("chunk blob read failed", "vault", r.PathValue("vault"), "err", src.err)
	case err != nil:
		h.log.Debug("chunk download interrupted", "err", err)
	case n != size:
		h.log.Error("chunk blob size mismatch", "vault", r.PathValue("vault"), "read", n, "want", size)
	default:
		return
	}
	// The status line is already out, so the only honest signal left is to
	// abort the connection: the client sees a transport error instead of a
	// short body that looks complete. The recoverer re-panics this.
	panic(http.ErrAbortHandler)
}

// readErrReader remembers a read error so getChunk can tell a failing blob
// from a client that went away.
type readErrReader struct {
	r   io.Reader
	err error
}

func (e *readErrReader) Read(p []byte) (int, error) {
	n, err := e.r.Read(p)
	if err != nil && err != io.EOF {
		e.err = err
	}
	return n, err
}

func (h *handlers) commit(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	var req obsyncv1.CommitRequest
	if err := readProto(w, r, &req, commitBodyLimit); err != nil {
		h.writeError(w, r, err)
		return
	}
	versions := make([]store.Version, len(req.Commits))
	for i, c := range req.Commits {
		versions[i] = commitFromProto(c)
	}
	results, vaultSeq, err := h.sync.Commit(r.Context(), sess.UserID, sess.DeviceID, r.PathValue("vault"), versions)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	resp := &obsyncv1.CommitResponse{VaultSeq: uint64(vaultSeq)}
	for _, res := range results {
		pr := &obsyncv1.CommitResult{FileId: res.FileID, Ok: res.Err == nil, Seq: uint64(res.Seq), HeadVersionId: res.HeadVersionID}
		if res.Err != nil {
			pr.Error = &obsyncv1.Error{Code: res.Err.Code, Message: res.Err.Msg}
		}
		resp.Results = append(resp.Results, pr)
	}
	writeProto(w, http.StatusOK, resp)
}

func (h *handlers) changes(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	since, err := queryInt(r, "since")
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	limit, err := queryInt(r, "limit")
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	page, err := h.sync.Changes(r.Context(), sess.UserID, r.PathValue("vault"), since, int(min(limit, syncsvc.MaxPageSize)))
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	resp := &obsyncv1.ChangesResponse{VaultSeq: uint64(page.VaultSeq), More: page.More}
	for _, v := range page.Versions {
		resp.Versions = append(resp.Versions, versionToProto(v))
	}
	writeProto(w, http.StatusOK, resp)
}

func (h *handlers) heads(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	var after []byte
	if s := r.URL.Query().Get("after"); s != "" {
		b, err := hexID(s, "after")
		if err != nil {
			h.writeError(w, r, err)
			return
		}
		after = b
	}
	limit, err := queryInt(r, "limit")
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	page, err := h.sync.Heads(r.Context(), sess.UserID, r.PathValue("vault"), after, int(min(limit, syncsvc.MaxHeadsPageSize)))
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	resp := &obsyncv1.HeadsResponse{More: page.More}
	for _, hd := range page.Heads {
		resp.Heads = append(resp.Heads, &obsyncv1.Head{FileId: hd.FileID, VersionId: hd.VersionID, Seq: uint64(hd.Seq), Deleted: hd.Deleted})
	}
	writeProto(w, http.StatusOK, resp)
}

func (h *handlers) history(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	fileID, err := pathID(r, "file")
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	versions, err := h.sync.History(r.Context(), sess.UserID, r.PathValue("vault"), fileID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeProto(w, http.StatusOK, versionsToProto(versions))
}

func (h *handlers) trash(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	versions, err := h.sync.Trash(r.Context(), sess.UserID, r.PathValue("vault"))
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeProto(w, http.StatusOK, versionsToProto(versions))
}
