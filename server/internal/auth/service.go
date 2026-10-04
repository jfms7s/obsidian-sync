// Package auth logs devices in with a username and password and
// authenticates their bearer tokens.
package auth

import (
	"context"
	"errors"
	"fmt"
	"runtime"
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

// maxPasswordBytes bounds the input to a password check.
const maxPasswordBytes = 1024

type Options struct {
	Params  Params // cost of the timing-equalising dummy hash; match real hashes. Zero = DefaultParams
	Now     func() time.Time
	Limiter *LoginLimiter
	// MaxConcurrentVerifies bounds how many password checks (each allocating
	// Params.Memory) run at once. Zero = runtime.GOMAXPROCS(0).
	MaxConcurrentVerifies int
}

type Service struct {
	st        Store
	now       func() time.Time
	limiter   *LoginLimiter
	dummyHash string
	verifying chan struct{}                                // semaphore around verify
	verify    func(password, encoded string) (bool, error) // VerifyPassword; replaced in tests
}

func NewService(st Store, opts Options) (*Service, error) {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Limiter == nil {
		opts.Limiter = NewLoginLimiter(5, time.Minute, opts.Now)
	}
	if opts.Params == (Params{}) {
		opts.Params = DefaultParams
	}
	if opts.MaxConcurrentVerifies <= 0 {
		opts.MaxConcurrentVerifies = runtime.GOMAXPROCS(0)
	}
	dummy, err := HashPassword("obsync-timing-dummy", opts.Params)
	if err != nil {
		return nil, fmt.Errorf("dummy hash: %w", err)
	}
	return &Service{st: st, now: opts.Now, limiter: opts.Limiter, dummyHash: dummy,
		verifying: make(chan struct{}, opts.MaxConcurrentVerifies), verify: VerifyPassword}, nil
}

// checkPassword runs verify once a semaphore slot is free. If ctx ends while
// waiting it gives up with ErrRateLimited: the server is saturated with checks.
func (s *Service) checkPassword(ctx context.Context, password, encoded string) (bool, error) {
	select {
	case s.verifying <- struct{}{}:
	case <-ctx.Done():
		return false, ErrRateLimited
	}
	defer func() { <-s.verifying }()
	return s.verify(password, encoded)
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
	if len(req.Password) > maxPasswordBytes {
		return LoginResult{}, apperr.New(apperr.Invalid, "password must be at most %d bytes", maxPasswordBytes)
	}
	key := strings.ToLower(strings.TrimSpace(req.Username))
	// Every attempt spends a token up front; only a successful login gives
	// them back. Lookup errors and corrupt hashes therefore count too.
	if !s.limiter.Take(key) {
		return LoginResult{}, ErrRateLimited
	}
	user, err := s.st.UserByUsername(ctx, strings.TrimSpace(req.Username))
	if errors.Is(err, store.ErrNotFound) {
		// Spend the same time as a real check so unknown usernames don't show.
		if _, err := s.checkPassword(ctx, req.Password, s.dummyHash); errors.Is(err, ErrRateLimited) {
			return LoginResult{}, err
		}
		return LoginResult{}, ErrInvalidCredentials
	}
	if err != nil {
		return LoginResult{}, fmt.Errorf("look up user: %w", err)
	}
	ok, err := s.checkPassword(ctx, req.Password, user.PasswordHash)
	if errors.Is(err, ErrRateLimited) {
		return LoginResult{}, err
	}
	if err != nil {
		return LoginResult{}, fmt.Errorf("verify password: %w", err)
	}
	if !ok {
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
		// Best effort: last-seen is informational and must not reject a
		// valid token.
		_ = s.st.TouchDevice(ctx, dev.ID)
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
