package auth

import (
	"context"
	"errors"
	"fmt"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

// The account's own TOTP set-up. Every check of a password or a code here
// spends the account's login budget, like a login; only a check that passes
// in full gives it back.

var (
	ErrWrongCode     = apperr.New(apperr.WrongPassword, "the code is wrong, or was used already")
	ErrCodeRequired  = apperr.New(apperr.WrongPassword, "a code from the authenticator app, or a recovery code, is required")
	errTOTPAlreadyOn = apperr.New(apperr.Invalid, "two-step sign-in is already on; turn it off first")
	errTOTPOff       = apperr.New(apperr.Invalid, "two-step sign-in is off")
	errTOTPNotBegun  = apperr.New(apperr.Invalid, "start setting up two-step sign-in first")
)

// TOTPStatus is whether the account has TOTP on and how many recovery codes
// it has left.
type TOTPStatus struct {
	Enabled      bool
	RecoveryLeft int
}

// TOTPSetup is a new secret to put into an authenticator app.
type TOTPSetup struct {
	Secret string // base32
	URI    string // otpauth://
}

func (s *Service) TOTPStatus(ctx context.Context, userID string) (TOTPStatus, error) {
	st, err := s.st.TOTP(ctx, userID)
	if errors.Is(err, store.ErrNotFound) {
		return TOTPStatus{}, ErrUnauthorized
	}
	if err != nil {
		return TOTPStatus{}, err
	}
	return TOTPStatus{Enabled: st.Secret != nil, RecoveryLeft: st.RecoveryLeft}, nil
}

// BeginTOTP checks the account password and stores a new pending secret,
// replacing one not confirmed yet. TOTP stays off until ConfirmTOTP.
func (s *Service) BeginTOTP(ctx context.Context, userID, password string) (TOTPSetup, error) {
	if st, err := s.st.TOTP(ctx, userID); err == nil && st.Secret != nil {
		return TOTPSetup{}, errTOTPAlreadyOn
	}
	if err := s.VerifyUserPassword(ctx, userID, password); err != nil {
		return TOTPSetup{}, err
	}
	user, err := s.st.UserByID(ctx, userID)
	if err != nil {
		return TOTPSetup{}, fmt.Errorf("look up user: %w", err)
	}
	secret, err := NewTOTPSecret()
	if err != nil {
		return TOTPSetup{}, err
	}
	ok, err := s.st.SetPendingTOTP(ctx, userID, secret)
	if err != nil {
		return TOTPSetup{}, err
	}
	if !ok {
		return TOTPSetup{}, errTOTPAlreadyOn // turned on meanwhile
	}
	return TOTPSetup{Secret: TOTPSecretText(secret), URI: TOTPURI(user.Username, secret)}, nil
}

// ConfirmTOTP turns TOTP on once code matches the pending secret, and
// returns the recovery codes, shown this once.
func (s *Service) ConfirmTOTP(ctx context.Context, userID, code string) ([]string, error) {
	st, key, err := s.spendAttempt(ctx, userID)
	if err != nil {
		return nil, err
	}
	switch {
	case st.Secret != nil:
		return nil, errTOTPAlreadyOn
	case st.PendingSecret == nil:
		return nil, errTOTPNotBegun
	}
	if len(code) > maxCodeBytes {
		return nil, ErrWrongCode
	}
	step, ok := VerifyTOTP(st.PendingSecret, code, s.now(), 0)
	if !ok {
		return nil, ErrWrongCode
	}
	shown, hashes, err := NewRecoveryCodes()
	if err != nil {
		return nil, err
	}
	done, err := s.st.ConfirmTOTP(ctx, userID, st.PendingSecret, step, hashes)
	if err != nil {
		return nil, err
	}
	if !done {
		return nil, errTOTPNotBegun // another begin or confirm came first
	}
	s.limiter.Reset(key)
	return shown, nil
}

// DisableTOTP turns TOTP off after checking the password and a code or a
// recovery code.
func (s *Service) DisableTOTP(ctx context.Context, userID, password, code string) error {
	if err := s.verifyBothFactors(ctx, userID, password, code); err != nil {
		return err
	}
	return s.st.DisableTOTP(ctx, userID)
}

// NewRecoveryCodes replaces the recovery codes after checking the password
// and a code or a recovery code, and returns the new ones, shown this once.
func (s *Service) NewRecoveryCodes(ctx context.Context, userID, password, code string) ([]string, error) {
	if err := s.verifyBothFactors(ctx, userID, password, code); err != nil {
		return nil, err
	}
	shown, hashes, err := NewRecoveryCodes()
	if err != nil {
		return nil, err
	}
	done, err := s.st.ReplaceRecoveryCodes(ctx, userID, hashes)
	if err != nil {
		return nil, err
	}
	if !done {
		return nil, errTOTPOff // turned off meanwhile
	}
	return shown, nil
}

// spendAttempt loads the account's TOTP state and takes one attempt from
// its login budget. key is the budget's key, to give it back on success.
func (s *Service) spendAttempt(ctx context.Context, userID string) (store.TOTPState, string, error) {
	user, err := s.st.UserByID(ctx, userID)
	if errors.Is(err, store.ErrNotFound) {
		return store.TOTPState{}, "", ErrUnauthorized
	}
	if err != nil {
		return store.TOTPState{}, "", fmt.Errorf("look up user: %w", err)
	}
	key := limiterKey(user.Username)
	if ok, wait := s.limiter.TakeWait(key); !ok {
		return store.TOTPState{}, "", &RateLimitedError{RetryAfter: wait}
	}
	st, err := s.st.TOTP(ctx, userID)
	if err != nil {
		return store.TOTPState{}, "", err
	}
	return st, key, nil
}

// verifyBothFactors checks the password and then the code (spending it), as
// one attempt against the login budget, given back only when both pass.
func (s *Service) verifyBothFactors(ctx context.Context, userID, password, code string) error {
	if password == "" {
		return ErrPasswordRequired
	}
	if len(password) > maxPasswordBytes {
		return errPasswordTooLong()
	}
	st, key, err := s.spendAttempt(ctx, userID)
	if err != nil {
		return err
	}
	if st.Secret == nil {
		return errTOTPOff
	}
	user, err := s.st.UserByID(ctx, userID)
	if err != nil {
		return fmt.Errorf("look up user: %w", err)
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
	if code == "" {
		return ErrCodeRequired
	}
	ok, err = s.checkSecondFactor(ctx, userID, st, code)
	if err != nil {
		return err
	}
	if !ok {
		return ErrWrongCode
	}
	s.limiter.Reset(key)
	return nil
}
