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
	LastStep      int64  // the last accepted time step; 0 before any
	RecoveryLeft  int    // unused recovery codes
}

func (s *Store) TOTP(ctx context.Context, userID string) (TOTPState, error) {
	var st TOTPState
	var last sql.NullInt64
	err := s.db.QueryRowContext(ctx, `SELECT totp_secret, totp_pending_secret, totp_last_step,
		(SELECT COUNT(*) FROM totp_recovery_codes WHERE user_id = users.id AND used_at IS NULL)
		FROM users WHERE id = ?`, userID).Scan(&st.Secret, &st.PendingSecret, &last, &st.RecoveryLeft)
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
			`UPDATE users SET totp_secret = ?, totp_pending_secret = NULL, totp_last_step = ? WHERE id = ?`, secret, step, userID)
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
			`UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_last_step = NULL WHERE id = ?`, userID)
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

// UseTOTPStep records step as accepted if it is later than the last accepted
// one and TOTP is on. It reports false when it was not (a replay, or a
// concurrent login that used the same or a later step first).
func (s *Store) UseTOTPStep(ctx context.Context, userID string, step int64) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_secret IS NOT NULL
		 AND (totp_last_step IS NULL OR totp_last_step < ?)`, step, userID, step)
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

// SetPendingTOTP stores secret as the account's enrolment in progress,
// replacing an earlier one. It reports false, storing nothing, when TOTP is
// already on.
func (s *Store) SetPendingTOTP(ctx context.Context, userID string, secret []byte) (bool, error) {
	if len(secret) == 0 {
		return false, fmt.Errorf("%w: empty totp secret", ErrInvalid)
	}
	res, err := s.db.ExecContext(ctx,
		`UPDATE users SET totp_pending_secret = ? WHERE id = ? AND totp_secret IS NULL`, secret, userID)
	if err != nil {
		return false, fmt.Errorf("begin totp: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("begin totp: %w", err)
	}
	return n == 1, nil
}

// ConfirmTOTP turns TOTP on with the pending secret, if it is still pending,
// accepted at step, with recoveryHashes as the recovery codes. It reports
// false, changing nothing, when pending is no longer the pending secret or
// TOTP is already on (a concurrent begin or confirm won).
func (s *Store) ConfirmTOTP(ctx context.Context, userID string, pending []byte, step int64, recoveryHashes [][]byte) (bool, error) {
	var done bool
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx,
			`UPDATE users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, totp_last_step = ?
			 WHERE id = ? AND totp_secret IS NULL AND totp_pending_secret = ?`, step, userID, pending)
		if err != nil {
			return fmt.Errorf("confirm totp: %w", err)
		}
		n, err := res.RowsAffected()
		if err != nil {
			return fmt.Errorf("confirm totp: %w", err)
		}
		if n != 1 {
			return nil
		}
		done = true
		return replaceRecoveryCodes(ctx, tx, userID, recoveryHashes)
	})
	return done && err == nil, err
}

// ReplaceRecoveryCodes replaces the recovery codes of an account with TOTP
// on. It reports false, changing nothing, when TOTP is off.
func (s *Store) ReplaceRecoveryCodes(ctx context.Context, userID string, hashes [][]byte) (bool, error) {
	var done bool
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		var on int
		if err := tx.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM users WHERE id = ? AND totp_secret IS NOT NULL`, userID).Scan(&on); err != nil {
			return fmt.Errorf("replace recovery codes: %w", err)
		}
		if on != 1 {
			return nil
		}
		done = true
		return replaceRecoveryCodes(ctx, tx, userID, hashes)
	})
	return done && err == nil, err
}
