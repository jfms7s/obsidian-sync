package api

import (
	"encoding/hex"
	"io"
	"net/http"
	"strconv"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/syncsvc"
)

// pathID decodes a 64-hex-character path segment into 32 bytes.
func pathID(r *http.Request, name string) ([]byte, error) {
	b, err := hex.DecodeString(r.PathValue(name))
	if err != nil || len(b) != 32 {
		return nil, apperr.New(apperr.Invalid, "%s must be 64 hex characters", name)
	}
	return b, nil
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
	id, err := pathID(r, "chunk")
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	if r.ContentLength < 0 {
		h.writeError(w, r, apperr.New(apperr.Invalid, "Content-Length is required"))
		return
	}
	body := http.MaxBytesReader(w, r.Body, syncsvc.MaxChunkCipherBytes+1)
	if err := h.sync.PutChunk(r.Context(), sess.UserID, r.PathValue("vault"), id, body, r.ContentLength); err != nil {
		h.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *handlers) getChunk(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	id, err := pathID(r, "chunk")
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	rc, err := h.sync.OpenChunk(r.Context(), sess.UserID, r.PathValue("vault"), id)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	defer rc.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.WriteHeader(http.StatusOK)
	if _, err := io.Copy(w, rc); err != nil {
		h.log.Debug("chunk download interrupted", "err", err)
	}
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
		b, err := hex.DecodeString(s)
		if err != nil || len(b) != 32 {
			h.writeError(w, r, apperr.New(apperr.Invalid, "after must be 64 hex characters"))
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
