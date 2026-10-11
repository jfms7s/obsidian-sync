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
	"github.com/jfms7s/obsidian-sync/server/internal/limits"
	"github.com/jfms7s/obsidian-sync/server/internal/metrics"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

var (
	ErrInvalidCredentials = apperr.New(apperr.Unauthorized, "invalid username or password")
	ErrRateLimited        = apperr.New(apperr.RateLimited, "too many failed logins; try again later")
	ErrUnauthorized       = apperr.New(apperr.Unauthorized, "missing or unknown token")
	ErrDeviceRevoked      = apperr.New(apperr.DeviceRevoked, "this device has been revoked")
	ErrPasswordRequired   = apperr.New(apperr.WrongPassword, "the account password is required")
	ErrWrongPassword      = apperr.New(apperr.WrongPassword, "wrong account password")
	// ErrSecondFactorRequired answers a login with the right password and no
	// code for an account with TOTP on. It tells the caller the password was
	// right (the usual two-step form), so it counts as a failed attempt.
	ErrSecondFactorRequired = apperr.New(apperr.SecondFactorRequired, "enter the code from your authenticator app, or a recovery code")
)

// touchInterval bounds how often a device's last-seen time is written.
const touchInterval = time.Minute

type Store interface {
	UserByUsername(ctx context.Context, username string) (store.User, error)
	UserByID(ctx context.Context, id string) (store.User, error)
	CreateDevice(ctx context.Context, d store.Device, tokenHash []byte) error
	DeviceByTokenHash(ctx context.Context, tokenHash []byte) (store.Device, error)
	TouchDevice(ctx context.Context, deviceID string) error
	TOTP(ctx context.Context, userID string) (store.TOTPState, error)
	UseTOTPStep(ctx context.Context, userID string, secret []byte, step int64) (bool, error)
	UseRecoveryCode(ctx context.Context, userID string, hash []byte) (bool, error)
	SetPendingTOTP(ctx context.Context, userID string, secret []byte) (bool, error)
	ConfirmTOTP(ctx context.Context, userID string, pending []byte, step int64, recoveryHashes [][]byte) (bool, error)
	ReplaceRecoveryCodes(ctx context.Context, userID string, hashes [][]byte) (bool, error)
	DisableTOTP(ctx context.Context, userID string) error
}

type Session struct {
	UserID   string
	DeviceID string
}

// maxPasswordBytes bounds the input to a password check.
const maxPasswordBytes = limits.MaxPasswordBytes

type Options struct {
	Params  Params // cost of the timing-equalising dummy hash; match real hashes. Zero = DefaultParams
	Now     func() time.Time
	Limiter *LoginLimiter
	// MaxConcurrentVerifies bounds how many password checks (each allocating
	// Params.Memory) run at once. Zero = runtime.GOMAXPROCS(0).
	MaxConcurrentVerifies int
	// Metrics counts login results; nil records nothing.
	Metrics *metrics.Obsync
}

type Service struct {
	metrics   *metrics.Obsync
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
		verifying: make(chan struct{}, opts.MaxConcurrentVerifies), verify: VerifyPassword, metrics: opts.Metrics}, nil
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
	// TOTPCode is the authenticator's code or a recovery code, for an
	// account with TOTP on; ignored otherwise.
	TOTPCode string
}

type LoginResult struct {
	Token  string
	Device store.Device
}

// limiterKey is the login limiter's key for a username, so every path that
// checks a user's password draws on the same budget.
func limiterKey(username string) string {
	return strings.ToLower(strings.TrimSpace(username))
}

func errPasswordTooLong() error {
	return apperr.New(apperr.Invalid, "password must be at most %d bytes", maxPasswordBytes)
}

func (s *Service) Login(ctx context.Context, req LoginRequest) (LoginResult, error) {
	res, err := s.login(ctx, req)
	switch {
	case err == nil:
		s.metrics.Login(metrics.LoginOK)
	case errors.Is(err, ErrRateLimited):
		s.metrics.Login(metrics.LoginLocked)
		s.metrics.RateLimited(metrics.LimiterLogin)
	default:
		s.metrics.Login(metrics.LoginFailed)
	}
	return res, err
}

func (s *Service) login(ctx context.Context, req LoginRequest) (LoginResult, error) {
	if len(req.Password) > maxPasswordBytes {
		return LoginResult{}, errPasswordTooLong()
	}
	// A name no account can have is refused before it becomes a limiter key,
	// so oversized or garbage names cannot fill the limiter. No password
	// check is spent on it: that it cannot exist is no secret, the rule is
	// public.
	if !ValidUsername(strings.TrimSpace(req.Username)) {
		return LoginResult{}, ErrInvalidCredentials
	}
	key := limiterKey(req.Username)
	// Every attempt spends a token up front; only a successful login gives
	// them back. Lookup errors and corrupt hashes therefore count too.
	if ok, wait := s.limiter.TakeWait(key); !ok {
		return LoginResult{}, &RateLimitedError{RetryAfter: wait}
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
	// The second factor, only once the password is known right: a code sent
	// with a wrong password is neither checked nor spent. Both failures give
	// the same answer, and neither gives the attempt back.
	totp, err := s.st.TOTP(ctx, user.ID)
	if err != nil {
		return LoginResult{}, fmt.Errorf("load second factor: %w", err)
	}
	if totp.Secret != nil {
		if strings.TrimSpace(req.TOTPCode) == "" {
			return LoginResult{}, ErrSecondFactorRequired
		}
		ok, err := s.checkSecondFactor(ctx, user.ID, totp, req.TOTPCode)
		if err != nil {
			return LoginResult{}, err
		}
		if !ok {
			return LoginResult{}, ErrInvalidCredentials
		}
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

// VerifyUserPassword checks the account password of an authenticated user,
// for actions a device token alone must not authorize. It shares Login's
// per-username attempt budget, verification semaphore and password cap, so
// guessing here costs the same as guessing at login. It returns nil,
// ErrPasswordRequired (empty password, no attempt spent), ErrWrongPassword,
// ErrRateLimited (a *RateLimitedError when the username's budget is spent),
// ErrUnauthorized (the user no longer exists) or an
// INVALID/internal error.
func (s *Service) VerifyUserPassword(ctx context.Context, userID, password string) error {
	if password == "" {
		return ErrPasswordRequired
	}
	if len(password) > maxPasswordBytes {
		return errPasswordTooLong()
	}
	user, err := s.st.UserByID(ctx, userID)
	if errors.Is(err, store.ErrNotFound) {
		return ErrUnauthorized
	}
	if err != nil {
		return fmt.Errorf("look up user: %w", err)
	}
	key := limiterKey(user.Username)
	if ok, wait := s.limiter.TakeWait(key); !ok {
		return &RateLimitedError{RetryAfter: wait}
	}
	ok, err := s.checkPassword(ctx, password, user.PasswordHash)
	if errors.Is(err, ErrRateLimited) {
		return err
	}
	if err != nil {
		return fmt.Errorf("verify password: %w", err)
	}
	if !ok {
		return ErrWrongPassword
	}
	s.limiter.Reset(key)
	return nil
}

func (s *Service) Authenticate(ctx context.Context, token string) (Session, error) {
	// A token NewToken cannot have produced is unknown without asking the
	// store, so junk tokens cost no database round trip.
	if !WellFormedToken(token) {
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
