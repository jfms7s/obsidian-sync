package api

import (
	"errors"
	"net/http"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

func (h *handlers) login(w http.ResponseWriter, r *http.Request) {
	var req obsyncv1.LoginRequest
	if err := readProto(w, r, &req, loginBodyLimit); err != nil {
		h.writeError(w, r, err)
		return
	}
	res, err := h.auth.Login(r.Context(), auth.LoginRequest{
		Username: req.Username, Password: req.Password, DeviceName: req.DeviceName, Platform: req.Platform,
	})
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeProto(w, http.StatusOK, &obsyncv1.LoginResponse{Token: res.Token, DeviceId: res.Device.ID, UserId: res.Device.UserID})
}

func (h *handlers) logout(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	if err := h.store.RevokeDevice(r.Context(), sess.UserID, sess.DeviceID); err != nil {
		h.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *handlers) listDevices(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	devices, err := h.store.ListDevices(r.Context(), sess.UserID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	resp := &obsyncv1.ListDevicesResponse{}
	for _, d := range devices {
		resp.Devices = append(resp.Devices, &obsyncv1.Device{
			DeviceId:     d.ID,
			Name:         d.Name,
			Platform:     d.Platform,
			CreatedAtMs:  d.CreatedAtMs,
			LastSeenAtMs: d.LastSeenAtMs,
			Current:      d.ID == sess.DeviceID,
			Revoked:      d.Revoked(),
		})
	}
	writeProto(w, http.StatusOK, resp)
}

func (h *handlers) revokeDevice(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	err := h.store.RevokeDevice(r.Context(), sess.UserID, r.PathValue("device"))
	if errors.Is(err, store.ErrNotFound) {
		h.writeError(w, r, apperr.New(apperr.NotFound, "device not found"))
		return
	}
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
