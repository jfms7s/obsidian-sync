package api

import (
	"net/http"

	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
)

// usage reports the caller's stored bytes against their quota. used_bytes is
// the sum over the owned vaults, the same number the quota check adds up
// (Store.UsageBytes), read here in one query with the per-vault figures.
func (h *handlers) usage(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	user, err := h.store.UserByID(r.Context(), sess.UserID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	vaults, err := h.store.OwnedVaultUsage(r.Context(), sess.UserID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	resp := &obsyncv1.GetUsageResponse{QuotaBytes: user.QuotaBytes}
	for _, v := range vaults {
		resp.UsedBytes += v.BytesUsed
		resp.Vaults = append(resp.Vaults, &obsyncv1.VaultUsage{VaultId: v.VaultID, UsedBytes: v.BytesUsed})
	}
	writeProto(w, http.StatusOK, resp)
}
