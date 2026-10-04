package api

import (
	"errors"
	"fmt"
	"net/http"

	"google.golang.org/protobuf/proto"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

const maxWrappedKeyBytes = 4096

func (h *handlers) getKeys(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	kb, err := h.store.KeyBundle(r.Context(), sess.UserID)
	if errors.Is(err, store.ErrNotFound) {
		h.writeError(w, r, apperr.New(apperr.NotFound, "no key bundle has been uploaded yet"))
		return
	}
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	var bundle obsyncv1.KeyBundle
	if err := proto.Unmarshal(kb.Bundle, &bundle); err != nil {
		h.writeError(w, r, fmt.Errorf("decode stored key bundle: %w", err))
		return
	}
	writeProto(w, http.StatusOK, &bundle)
}

func (h *handlers) putKeys(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	var kb obsyncv1.KeyBundle
	if err := readProto(w, r, &kb); err != nil {
		h.writeError(w, r, err)
		return
	}
	if err := validateKeyBundle(&kb); err != nil {
		h.writeError(w, r, err)
		return
	}
	data, err := proto.Marshal(&kb)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	err = h.store.PutKeyBundle(r.Context(), sess.UserID, store.KeyBundle{
		PublicEncKey: kb.PublicEncKey, PublicSignKey: kb.PublicSignKey, Bundle: data,
	})
	if errors.Is(err, store.ErrKeyMismatch) {
		h.writeError(w, r, apperr.New(apperr.Invalid, "public keys cannot be changed"))
		return
	}
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func validateKeyBundle(kb *obsyncv1.KeyBundle) error {
	p := kb.GetPassParams()
	switch {
	case len(kb.PublicEncKey) != 32:
		return apperr.New(apperr.Invalid, "public_enc_key must be 32 bytes")
	case len(kb.PublicSignKey) != 32:
		return apperr.New(apperr.Invalid, "public_sign_key must be 32 bytes")
	case len(kb.PassSalt) < 16 || len(kb.PassSalt) > 64:
		return apperr.New(apperr.Invalid, "pass_salt must be 16 to 64 bytes")
	case p == nil || p.MemoryKib < 8192 || p.Iterations < 1 || p.Parallelism < 1:
		return apperr.New(apperr.Invalid, "pass_params are missing or weaker than 8 MiB / 1 iteration")
	case len(kb.PassWrapped) == 0 || len(kb.PassWrapped) > maxWrappedKeyBytes:
		return apperr.New(apperr.Invalid, "pass_wrapped must be 1 to %d bytes", maxWrappedKeyBytes)
	case len(kb.RecoveryWrapped) == 0 || len(kb.RecoveryWrapped) > maxWrappedKeyBytes:
		return apperr.New(apperr.Invalid, "recovery_wrapped must be 1 to %d bytes", maxWrappedKeyBytes)
	}
	return nil
}
