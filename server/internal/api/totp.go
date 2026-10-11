package api

import (
	"net/http"

	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
)

func (h *handlers) registerTOTPRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/account/totp", h.authed(h.totpStatus))
	mux.HandleFunc("POST /v1/account/totp/begin", h.authed(h.totpBegin))
	mux.HandleFunc("POST /v1/account/totp/confirm", h.authed(h.totpConfirm))
	mux.HandleFunc("POST /v1/account/totp/disable", h.authed(h.totpDisable))
	mux.HandleFunc("POST /v1/account/totp/recovery-codes", h.authed(h.totpRecoveryCodes))
}

func (h *handlers) totpStatus(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	st, err := h.auth.TOTPStatus(r.Context(), sess.UserID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeProto(w, http.StatusOK, &obsyncv1.TotpStatusResponse{Enabled: st.Enabled, RecoveryCodesLeft: uint32(max(st.RecoveryLeft, 0))}) //nolint:gosec // G115: at most a handful of codes
}

func (h *handlers) totpBegin(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	var req obsyncv1.TotpBeginRequest
	if err := readProto(w, r, &req, loginBodyLimit); err != nil {
		h.writeError(w, r, err)
		return
	}
	setup, err := h.auth.BeginTOTP(r.Context(), sess.UserID, req.CurrentPassword)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeProto(w, http.StatusOK, &obsyncv1.TotpBeginResponse{Secret: setup.Secret, OtpauthUri: setup.URI})
}

func (h *handlers) totpConfirm(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	var req obsyncv1.TotpConfirmRequest
	if err := readProto(w, r, &req, loginBodyLimit); err != nil {
		h.writeError(w, r, err)
		return
	}
	codes, err := h.auth.ConfirmTOTP(r.Context(), sess.UserID, req.Code)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeProto(w, http.StatusOK, &obsyncv1.TotpRecoveryCodesResponse{RecoveryCodes: codes})
}

func (h *handlers) totpDisable(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	var req obsyncv1.TotpVerifyRequest
	if err := readProto(w, r, &req, loginBodyLimit); err != nil {
		h.writeError(w, r, err)
		return
	}
	if err := h.auth.DisableTOTP(r.Context(), sess.UserID, req.CurrentPassword, req.Code); err != nil {
		h.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *handlers) totpRecoveryCodes(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	var req obsyncv1.TotpVerifyRequest
	if err := readProto(w, r, &req, loginBodyLimit); err != nil {
		h.writeError(w, r, err)
		return
	}
	codes, err := h.auth.NewRecoveryCodes(r.Context(), sess.UserID, req.CurrentPassword, req.Code)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeProto(w, http.StatusOK, &obsyncv1.TotpRecoveryCodesResponse{RecoveryCodes: codes})
}
