package api

import (
	"net/http"

	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
)

func (h *handlers) getKeys(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	kb, err := h.vaults.KeyBundle(r.Context(), sess.UserID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeProto(w, http.StatusOK, kb)
}

// putKeys stores or replaces the user's key bundle; vaultsvc.PutKeyBundle
// says when the account password is needed.
func (h *handlers) putKeys(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	var req obsyncv1.KeyBundle
	if err := readProto(w, r, &req, keysBodyLimit); err != nil {
		h.writeError(w, r, err)
		return
	}
	if err := h.vaults.PutKeyBundle(r.Context(), sess.UserID, &req); err != nil {
		h.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
