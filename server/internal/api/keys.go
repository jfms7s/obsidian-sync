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

const (
	maxWrappedKeyBytes = 4096

	// Argon2 parameter ceilings. Clients run whatever is stored here, so an
	// absurd value would lock the user out of every device.
	maxArgon2MemoryKib   = 4 << 20 // 4 GiB
	maxArgon2Iterations  = 64
	maxArgon2Parallelism = 16
)

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
	if err := unmarshalOpts.Unmarshal(kb.Bundle, &bundle); err != nil {
		h.writeError(w, r, fmt.Errorf("decode stored key bundle: %w", err))
		return
	}
	writeProto(w, http.StatusOK, &bundle)
}

// putKeys stores the user's first key bundle, or replaces it (a passphrase
// change). The first upload needs only the device token; a replacement also
// needs the account password, so a stolen token cannot overwrite the wrapped
// private keys or their KDF parameters and break recovery.
func (h *handlers) putKeys(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	var req obsyncv1.KeyBundle
	if err := readProto(w, r, &req, keysBodyLimit); err != nil {
		h.writeError(w, r, err)
		return
	}
	if err := validateKeyBundle(&req); err != nil {
		h.writeError(w, r, err)
		return
	}
	// A password sent with a first upload is ignored. Two first uploads
	// racing past this check are settled by the store: the later one must
	// carry the very public keys the earlier one just stored, which no one
	// else knows before they are uploaded.
	_, err := h.store.KeyBundle(r.Context(), sess.UserID)
	switch {
	case errors.Is(err, store.ErrNotFound):
	case err != nil:
		h.writeError(w, r, err)
		return
	default:
		if err := h.auth.VerifyUserPassword(r.Context(), sess.UserID, req.CurrentPassword); err != nil {
			if errors.Is(err, auth.ErrPasswordRequired) {
				err = apperr.New(apperr.WrongPassword, "replacing the key bundle requires the account password in current_password")
			}
			h.writeError(w, r, err)
			return
		}
	}
	// Store only the validated fields, never whatever else came in (and
	// never the password).
	p := req.GetPassParams()
	kb := &obsyncv1.KeyBundle{
		PublicEncKey:  req.PublicEncKey,
		PublicSignKey: req.PublicSignKey,
		PassSalt:      req.PassSalt,
		PassParams: &obsyncv1.Argon2Params{
			MemoryKib: p.MemoryKib, Iterations: p.Iterations, Parallelism: p.Parallelism,
		},
		PassWrapped:     req.PassWrapped,
		RecoveryWrapped: req.RecoveryWrapped,
	}
	data, err := proto.Marshal(kb)
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
	case p.MemoryKib > maxArgon2MemoryKib || p.Iterations > maxArgon2Iterations || p.Parallelism > maxArgon2Parallelism:
		return apperr.New(apperr.Invalid, "pass_params exceed %d KiB / %d iterations / %d lanes",
			maxArgon2MemoryKib, maxArgon2Iterations, maxArgon2Parallelism)
	case len(kb.PassWrapped) == 0 || len(kb.PassWrapped) > maxWrappedKeyBytes:
		return apperr.New(apperr.Invalid, "pass_wrapped must be 1 to %d bytes", maxWrappedKeyBytes)
	case len(kb.RecoveryWrapped) == 0 || len(kb.RecoveryWrapped) > maxWrappedKeyBytes:
		return apperr.New(apperr.Invalid, "recovery_wrapped must be 1 to %d bytes", maxWrappedKeyBytes)
	}
	return nil
}
