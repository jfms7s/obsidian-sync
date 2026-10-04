package store

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
)

type User struct {
	ID           string
	Username     string
	PasswordHash string
	QuotaBytes   int64
	CreatedAtMs  int64
}

const userColumns = `id, username, password_hash, quota_bytes, created_at`

func scanUser(row rowScanner) (User, error) {
	var u User
	err := row.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.QuotaBytes, &u.CreatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("scan user: %w", err)
	}
	return u, nil
}

func (s *Store) CreateUser(ctx context.Context, u User) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO users (id, username, password_hash, quota_bytes, created_at) VALUES (?, ?, ?, ?, ?)`,
		u.ID, u.Username, u.PasswordHash, u.QuotaBytes, s.nowMs())
	if isUniqueViolation(err) {
		return ErrExists
	}
	if err != nil {
		return fmt.Errorf("create user: %w", err)
	}
	return nil
}

func (s *Store) UserByUsername(ctx context.Context, username string) (User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `SELECT `+userColumns+` FROM users WHERE username = ?`, username))
}

func (s *Store) UserByID(ctx context.Context, id string) (User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `SELECT `+userColumns+` FROM users WHERE id = ?`, id))
}

func (s *Store) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+userColumns+` FROM users ORDER BY username`)
	if err != nil {
		return nil, fmt.Errorf("list users: %w", err)
	}
	defer rows.Close()
	var out []User
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func (s *Store) SetPassword(ctx context.Context, userID, hash string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE users SET password_hash = ? WHERE id = ?`, hash, userID)
	if err != nil {
		return fmt.Errorf("set password: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

type Device struct {
	ID           string
	UserID       string
	Name         string
	Platform     string
	CreatedAtMs  int64
	LastSeenAtMs int64
	RevokedAtMs  int64 // 0 while the device is active
}

func (d Device) Revoked() bool { return d.RevokedAtMs != 0 }

const deviceColumns = `id, user_id, name, platform, created_at, last_seen_at, revoked_at`

func scanDevice(row rowScanner) (Device, error) {
	var d Device
	err := row.Scan(&d.ID, &d.UserID, &d.Name, &d.Platform, &d.CreatedAtMs, &d.LastSeenAtMs, &d.RevokedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return Device{}, ErrNotFound
	}
	if err != nil {
		return Device{}, fmt.Errorf("scan device: %w", err)
	}
	return d, nil
}

func (s *Store) CreateDevice(ctx context.Context, d Device, tokenHash []byte) error {
	now := s.nowMs()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO devices (id, user_id, token_hash, name, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		d.ID, d.UserID, tokenHash, d.Name, d.Platform, now, now)
	if isUniqueViolation(err) {
		return ErrExists
	}
	if err != nil {
		return fmt.Errorf("create device: %w", err)
	}
	return nil
}

func (s *Store) DeviceByTokenHash(ctx context.Context, tokenHash []byte) (Device, error) {
	return scanDevice(s.db.QueryRowContext(ctx, `SELECT `+deviceColumns+` FROM devices WHERE token_hash = ?`, tokenHash))
}

func (s *Store) ListDevices(ctx context.Context, userID string) ([]Device, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+deviceColumns+` FROM devices WHERE user_id = ? ORDER BY created_at, id`, userID)
	if err != nil {
		return nil, fmt.Errorf("list devices: %w", err)
	}
	defer rows.Close()
	var out []Device
	for rows.Next() {
		d, err := scanDevice(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// RevokeDevice is idempotent for the owner and ErrNotFound for anyone else.
func (s *Store) RevokeDevice(ctx context.Context, userID, deviceID string) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE devices SET revoked_at = CASE WHEN revoked_at = 0 THEN ? ELSE revoked_at END WHERE id = ? AND user_id = ?`,
		s.nowMs(), deviceID, userID)
	if err != nil {
		return fmt.Errorf("revoke device: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) TouchDevice(ctx context.Context, deviceID string) error {
	if _, err := s.db.ExecContext(ctx, `UPDATE devices SET last_seen_at = ? WHERE id = ?`, s.nowMs(), deviceID); err != nil {
		return fmt.Errorf("touch device: %w", err)
	}
	return nil
}

type KeyBundle struct {
	PublicEncKey  []byte
	PublicSignKey []byte
	Bundle        []byte // the serialized obsync.v1.KeyBundle, opaque here
	UpdatedAtMs   int64
}

func (s *Store) KeyBundle(ctx context.Context, userID string) (KeyBundle, error) {
	var kb KeyBundle
	err := s.db.QueryRowContext(ctx,
		`SELECT public_enc_key, public_sign_key, bundle, updated_at FROM key_bundles WHERE user_id = ?`, userID).
		Scan(&kb.PublicEncKey, &kb.PublicSignKey, &kb.Bundle, &kb.UpdatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return KeyBundle{}, ErrNotFound
	}
	if err != nil {
		return KeyBundle{}, fmt.Errorf("read key bundle: %w", err)
	}
	return kb, nil
}

// PutKeyBundle stores the first bundle, or replaces the wrapped private keys
// of an existing one (a passphrase change). Public keys never change: other
// members pin them, so a different public key is rejected.
func (s *Store) PutKeyBundle(ctx context.Context, userID string, kb KeyBundle) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		var enc, sign []byte
		err := tx.QueryRowContext(ctx,
			`SELECT public_enc_key, public_sign_key FROM key_bundles WHERE user_id = ?`, userID).Scan(&enc, &sign)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			_, err = tx.ExecContext(ctx,
				`INSERT INTO key_bundles (user_id, public_enc_key, public_sign_key, bundle, updated_at) VALUES (?, ?, ?, ?, ?)`,
				userID, kb.PublicEncKey, kb.PublicSignKey, kb.Bundle, s.nowMs())
		case err != nil:
			return fmt.Errorf("read key bundle: %w", err)
		case !bytes.Equal(enc, kb.PublicEncKey) || !bytes.Equal(sign, kb.PublicSignKey):
			return ErrKeyMismatch
		default:
			_, err = tx.ExecContext(ctx,
				`UPDATE key_bundles SET bundle = ?, updated_at = ? WHERE user_id = ?`, kb.Bundle, s.nowMs(), userID)
		}
		if err != nil {
			return fmt.Errorf("write key bundle: %w", err)
		}
		return nil
	})
}
