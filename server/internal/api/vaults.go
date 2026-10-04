package api

import (
	"errors"
	"net/http"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

const (
	maxEncNameBytes   = 1024
	maxSealedKeyBytes = 1024
)

func (h *handlers) registerVaultRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/vaults", h.authed(h.listVaults))
	mux.HandleFunc("POST /v1/vaults", h.authed(h.createVault))
	mux.HandleFunc("GET /v1/vaults/{vault}/keys", h.authed(h.vaultKeys))
	mux.HandleFunc("POST /v1/vaults/{vault}/chunks/exists", h.authed(h.chunksExist))
	mux.HandleFunc("PUT /v1/vaults/{vault}/chunks/{chunk}", h.authed(h.putChunk))
	mux.HandleFunc("GET /v1/vaults/{vault}/chunks/{chunk}", h.authed(h.getChunk))
	mux.HandleFunc("POST /v1/vaults/{vault}/commit", h.authed(h.commit))
	mux.HandleFunc("GET /v1/vaults/{vault}/changes", h.authed(h.changes))
	mux.HandleFunc("GET /v1/vaults/{vault}/heads", h.authed(h.heads))
	mux.HandleFunc("GET /v1/vaults/{vault}/files/{file}/history", h.authed(h.history))
	mux.HandleFunc("GET /v1/vaults/{vault}/trash", h.authed(h.trash))
}

func (h *handlers) listVaults(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	vaults, err := h.store.ListVaults(r.Context(), sess.UserID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	resp := &obsyncv1.ListVaultsResponse{}
	for _, v := range vaults {
		resp.Vaults = append(resp.Vaults, vaultToProto(v))
	}
	writeProto(w, http.StatusOK, resp)
}

func (h *handlers) createVault(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	var req obsyncv1.CreateVaultRequest
	if err := readProto(w, r, &req, smallBodyLimit); err != nil {
		h.writeError(w, r, err)
		return
	}
	if err := validateCreateVault(&req); err != nil {
		h.writeError(w, r, err)
		return
	}
	keys := make([]store.VaultKey, len(req.Keys))
	for i, k := range req.Keys {
		keys[i] = store.VaultKey{Epoch: int(k.Epoch), SealedKey: k.SealedKey}
	}
	err := h.store.CreateVault(r.Context(), store.Vault{ID: req.VaultId, OwnerID: sess.UserID, EncName: req.EncName}, keys)
	if errors.Is(err, store.ErrExists) {
		h.writeError(w, r, apperr.New(apperr.Invalid, "vault id already exists"))
		return
	}
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	v, err := h.store.VaultForMember(r.Context(), req.VaultId, sess.UserID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeProto(w, http.StatusCreated, vaultToProto(v))
}

// validateCreateVault requires exactly the naming key (epoch 0) and the first
// content key (epoch 1), both sealed to the creator.
func validateCreateVault(req *obsyncv1.CreateVaultRequest) error {
	if !ids.Valid(req.VaultId) {
		return apperr.New(apperr.Invalid, "vault_id must be 32 lowercase hex characters")
	}
	if len(req.EncName) == 0 || len(req.EncName) > maxEncNameBytes {
		return apperr.New(apperr.Invalid, "enc_name must be 1 to %d bytes", maxEncNameBytes)
	}
	seen := map[uint32]bool{}
	for _, k := range req.Keys {
		if k.Epoch > 1 {
			return apperr.New(apperr.Invalid, "a new vault has only epochs 0 (naming key) and 1")
		}
		if seen[k.Epoch] {
			return apperr.New(apperr.Invalid, "epoch %d appears twice", k.Epoch)
		}
		if len(k.SealedKey) == 0 || len(k.SealedKey) > maxSealedKeyBytes {
			return apperr.New(apperr.Invalid, "sealed keys must be 1 to %d bytes", maxSealedKeyBytes)
		}
		seen[k.Epoch] = true
	}
	if !seen[0] || !seen[1] {
		return apperr.New(apperr.Invalid, "keys for epochs 0 and 1 are required")
	}
	return nil
}

func (h *handlers) vaultKeys(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	vaultID := r.PathValue("vault")
	if _, err := h.store.VaultForMember(r.Context(), vaultID, sess.UserID); errors.Is(err, store.ErrNotFound) {
		h.writeError(w, r, apperr.New(apperr.NotFound, "vault not found"))
		return
	} else if err != nil {
		h.writeError(w, r, err)
		return
	}
	keys, err := h.store.VaultKeys(r.Context(), vaultID, sess.UserID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	resp := &obsyncv1.VaultKeysResponse{}
	for _, k := range keys {
		resp.Keys = append(resp.Keys, &obsyncv1.VaultKey{Epoch: uint32(k.Epoch), SealedKey: k.SealedKey})
	}
	writeProto(w, http.StatusOK, resp)
}
