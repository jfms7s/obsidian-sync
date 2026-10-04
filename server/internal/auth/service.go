// Package auth logs devices in with a username and password and
// authenticates their bearer tokens.
package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

var (
	ErrInvalidCredentials = apperr.New(apperr.Unauthorized, "invalid username or password")
	ErrRateLimited        = apperr.New(apperr.RateLimited, "too many failed logins; try again later")
	ErrUnauthorized       = apperr.New(apperr.Unauthorized, "missing or unknown token")
	ErrDeviceRevoked      = apperr.New(apperr.DeviceRevoked, "this device has been revoked")
)

// touchInterval bounds how often a device's last-seen time is written.
const touchInterval = time.Minute

type Store interface {
	UserByUsername(ctx context.Context, username string) (store.User, error)
	CreateDevice(ctx context.Context, d store.Device, tokenHash []byte) error
	DeviceByTokenHash(ctx context.Context, tokenHash []byte) (store.Device, error)
	TouchDevice(ctx context.Context, deviceID string) error
}

type Session struct {
	UserID   string
	DeviceID string
}

type Options struct {
	Params  Params // cost of the timing-equalising dummy hash; match real hashes
	Now     func() time.Time
	Limiter *LoginLimiter
}

type Service struct {
	st        Store
	now       func() time.Time
	limiter   *LoginLimiter
	dummyHash string
}

func NewService(st Store, opts Options) (*Service, error) {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Limiter == nil {
		opts.Limiter = NewLoginLimiter(5, time.Minute, opts.Now)
	}
	dummy, err := HashPassword("obsync-timing-dummy", opts.Params)
	if err != nil {
		return nil, fmt.Errorf("dummy hash: %w", err)
	}
	return &Service{st: st, now: opts.Now, limiter: opts.Limiter, dummyHash: dummy}, nil
}

type LoginRequest struct {
	Username   string
	Password   string
	DeviceName string
	Platform   string
}

type LoginResult struct {
	Token  string
	Device store.Device
}

func (s *Service) Login(ctx context.Context, req LoginRequest) (LoginResult, error) {
	key := strings.ToLower(strings.TrimSpace(req.Username))
	if !s.limiter.Allow(key) {
		return LoginResult{}, ErrRateLimited
	}
	user, err := s.st.UserByUsername(ctx, strings.TrimSpace(req.Username))
	if errors.Is(err, store.ErrNotFound) {
		// Spend the same time as a real check so unknown usernames don't show.
		_, _ = VerifyPassword(req.Password, s.dummyHash)
		s.limiter.Fail(key)
		return LoginResult{}, ErrInvalidCredentials
	}
	if err != nil {
		return LoginResult{}, fmt.Errorf("look up user: %w", err)
	}
	ok, err := VerifyPassword(req.Password, user.PasswordHash)
	if err != nil {
		return LoginResult{}, fmt.Errorf("verify password: %w", err)
	}
	if !ok {
		s.limiter.Fail(key)
		return LoginResult{}, ErrInvalidCredentials
	}
	s.limiter.Reset(key)

	token, hash, err := NewToken()
	if err != nil {
		return LoginResult{}, err
	}
	dev := store.Device{
		ID:       ids.New(),
		UserID:   user.ID,
		Name:     clean(req.DeviceName, "unnamed device", 100),
		Platform: clean(req.Platform, "unknown", 32),
	}
	if err := s.st.CreateDevice(ctx, dev, hash); err != nil {
		return LoginResult{}, err
	}
	stored, err := s.st.DeviceByTokenHash(ctx, hash)
	if err != nil {
		return LoginResult{}, fmt.Errorf("read new device: %w", err)
	}
	return LoginResult{Token: token, Device: stored}, nil
}

func (s *Service) Authenticate(ctx context.Context, token string) (Session, error) {
	if token == "" {
		return Session{}, ErrUnauthorized
	}
	dev, err := s.st.DeviceByTokenHash(ctx, HashToken(token))
	if errors.Is(err, store.ErrNotFound) {
		return Session{}, ErrUnauthorized
	}
	if err != nil {
		return Session{}, fmt.Errorf("look up device: %w", err)
	}
	if dev.Revoked() {
		return Session{}, ErrDeviceRevoked
	}
	if s.now().UnixMilli()-dev.LastSeenAtMs > touchInterval.Milliseconds() {
		if err := s.st.TouchDevice(ctx, dev.ID); err != nil {
			return Session{}, err
		}
	}
	return Session{UserID: dev.UserID, DeviceID: dev.ID}, nil
}

// clean trims s, substitutes def when empty and truncates to max runes.
func clean(s, def string, max int) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return def
	}
	if utf8.RuneCountInString(s) > max {
		s = string([]rune(s)[:max])
	}
	return s
}
