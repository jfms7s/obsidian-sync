package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// TOTPState is an account's second factor. Secret is nil while TOTP is off.
type TOTPState struct {
	Secret        []byte
	PendingSecret []byte // set between enrolment begin and confirm
	PendingAtMs   int64  // when PendingSecret was set
	LastStep      int64  // the last accepted time step; 0 before any
	RecoveryLeft  int    // unused recovery codes
}

func (s *Store) TOTP(ctx context.Context, userID string) (TOTPState, error) {
	var st TOTPState
	var last, pendingAt sql.NullInt64
	err := s.db.QueryRowContext(ctx, `SELECT totp_secret, totp_pending_secret, totp_pending_at, totp_last_step,
		(SELECT COUNT(*) FROM totp_recovery_codes WHERE user_id = users.id AND used_at IS NULL)
		FROM users WHERE id = ?`, userID).Scan(&st.Secret, &st.PendingSecret, &pendingAt, &last, &st.RecoveryLeft)
	if errors.Is(err, sql.ErrNoRows) {
		return TOTPState{}, ErrNotFound
	}
	if err != nil {
		return TOTPState{}, fmt.Errorf("totp state: %w", err)
	}
	if len(st.Secret) == 0 {
		st.Secret = nil
	}
	if len(st.PendingSecret) == 0 {
		st.PendingSecret = nil
	}
	st.LastStep = last.Int64
	st.PendingAtMs = pendingAt.Int64
	return st, nil
}

// EnableTOTP turns TOTP on with secret, accepted at step, and replaces the
// recovery codes with recoveryHashes. Any pending secret is cleared.
func (s *Store) EnableTOTP(ctx context.Context, userID string, secret []byte, step int64, recoveryHashes [][]byte) error {
	if len(secret) == 0 {
		return fmt.Errorf("%w: empty totp secret", ErrInvalid)
	}
	return s.withTx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx,
			`UPDATE users SET totp_secret = ?, totp_pending_secret = NULL, totp_pending_at = NULL, totp_last_step = ? WHERE id = ?`, secret, step, userID)
		if err != nil {
			return fmt.Errorf("enable totp: %w", err)
		}
		if n, err := res.RowsAffected(); err != nil || n != 1 {
			return ErrNotFound
		}
		return replaceRecoveryCodes(ctx, tx, userID, recoveryHashes)
	})
}

// DisableTOTP turns TOTP off: secret, pending secret, last step and recovery
// codes are all removed.
func (s *Store) DisableTOTP(ctx context.Context, userID string) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx,
			`UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_pending_at = NULL, totp_last_step = NULL WHERE id = ?`, userID)
		if err != nil {
			return fmt.Errorf("disable totp: %w", err)
		}
		if n, err := res.RowsAffected(); err != nil || n != 1 {
			return ErrNotFound
		}
		return replaceRecoveryCodes(ctx, tx, userID, nil)
	})
}

func replaceRecoveryCodes(ctx context.Context, tx *sql.Tx, userID string, hashes [][]byte) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM totp_recovery_codes WHERE user_id = ?`, userID); err != nil {
		return fmt.Errorf("delete recovery codes: %w", err)
	}
	for _, h := range hashes {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO totp_recovery_codes (user_id, code_hash, used_at) VALUES (?, ?, NULL)`, userID, h); err != nil {
			return fmt.Errorf("store recovery code: %w", err)
		}
	}
	return nil
}

// UseTOTPStep records step as accepted if TOTP is still on with secret (the
// one the code was checked against) and step is later than the last accepted
// one. It reports false when it was not (a replay, a concurrent login that
// used the same or a later step first, or a secret changed meanwhile).
func (s *Store) UseTOTPStep(ctx context.Context, userID string, secret []byte, step int64) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_secret = ?
		 AND (totp_last_step IS NULL OR totp_last_step < ?)`, step, userID, secret, step)
	if err != nil {
		return false, fmt.Errorf("use totp step: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("use totp step: %w", err)
	}
	return n == 1, nil
}

// UseRecoveryCode marks the unused recovery code with hash as used. It
// reports false when there is none (wrong, or used already).
func (s *Store) UseRecoveryCode(ctx context.Context, userID string, hash []byte) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE totp_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL
		 AND EXISTS (SELECT 1 FROM users WHERE id = ? AND totp_secret IS NOT NULL)`, s.nowMs(), userID, hash, userID)
	if err != nil {
		return false, fmt.Errorf("use recovery code: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("use recovery code: %w", err)
	}
	return n == 1, nil
}
