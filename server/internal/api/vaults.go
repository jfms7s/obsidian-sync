package api

import (
	"net/http"

	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/vaultsvc"
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
	vaults, err := h.vaults.ListVaults(r.Context(), sess.UserID)
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
	nv := vaultsvc.NewVault{ID: req.VaultId, EncName: req.EncName, Keys: make([]store.VaultKey, len(req.Keys))}
	for i, k := range req.Keys {
		nv.Keys[i] = store.VaultKey{Epoch: int(k.Epoch), SealedKey: k.SealedKey}
	}
	v, err := h.vaults.CreateVault(r.Context(), sess.UserID, nv)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeProto(w, http.StatusCreated, vaultToProto(v))
}

func (h *handlers) vaultKeys(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	keys, err := h.vaults.VaultKeys(r.Context(), sess.UserID, r.PathValue("vault"))
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
