package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

type Vault struct {
	ID           string
	OwnerID      string
	EncName      []byte
	Seq          int64
	CurrentEpoch int
	BytesUsed    int64
	CreatedAtMs  int64
}

type VaultKey struct {
	Epoch     int // 0 = naming key
	SealedKey []byte
}

const vaultColumns = `v.id, v.owner_id, v.enc_name, v.seq, v.current_epoch, v.bytes_used, v.created_at`

func scanVault(row rowScanner) (Vault, error) {
	var v Vault
	err := row.Scan(&v.ID, &v.OwnerID, &v.EncName, &v.Seq, &v.CurrentEpoch, &v.BytesUsed, &v.CreatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return Vault{}, ErrNotFound
	}
	if err != nil {
		return Vault{}, fmt.Errorf("scan vault: %w", err)
	}
	return v, nil
}

// CreateVault stores a vault at epoch 1, makes its owner the only member and
// stores the owner's sealed keys. A repeated epoch in keys is ErrInvalid.
func (s *Store) CreateVault(ctx context.Context, v Vault, keys []VaultKey) error {
	seen := make(map[int]bool, len(keys))
	for _, k := range keys {
		if seen[k.Epoch] {
			return fmt.Errorf("%w: vault key epoch %d appears twice", ErrInvalid, k.Epoch)
		}
		seen[k.Epoch] = true
	}
	return s.withTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx,
			`INSERT INTO vaults (id, owner_id, enc_name, seq, current_epoch, bytes_used, created_at) VALUES (?, ?, ?, 0, 1, 0, ?)`,
			v.ID, v.OwnerID, v.EncName, s.nowMs())
		if isUniqueViolation(err) {
			return ErrExists
		}
		if err != nil {
			return fmt.Errorf("create vault: %w", err)
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO vault_members (vault_id, user_id, role) VALUES (?, ?, 'owner')`, v.ID, v.OwnerID); err != nil {
			return fmt.Errorf("add owner: %w", err)
		}
		for _, k := range keys {
			if _, err := tx.ExecContext(ctx,
				`INSERT INTO vault_keys (vault_id, user_id, epoch, sealed_key) VALUES (?, ?, ?, ?)`,
				v.ID, v.OwnerID, k.Epoch, k.SealedKey); err != nil {
				return fmt.Errorf("store vault key: %w", err)
			}
		}
		return nil
	})
}

func (s *Store) ListVaults(ctx context.Context, userID string) ([]Vault, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+vaultColumns+` FROM vaults v JOIN vault_members m ON m.vault_id = v.id
		 WHERE m.user_id = ? ORDER BY v.created_at, v.id`, userID)
	if err != nil {
		return nil, fmt.Errorf("list vaults: %w", err)
	}
	defer rows.Close()
	var out []Vault
	for rows.Next() {
		v, err := scanVault(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *Store) VaultForMember(ctx context.Context, vaultID, userID string) (Vault, error) {
	return scanVault(s.db.QueryRowContext(ctx,
		`SELECT `+vaultColumns+` FROM vaults v JOIN vault_members m ON m.vault_id = v.id
		 WHERE v.id = ? AND m.user_id = ?`, vaultID, userID))
}

// VaultKeys returns the user's sealed keys for the vault, ordered by epoch.
// ErrNotFound means the vault does not exist or the user is not a member.
func (s *Store) VaultKeys(ctx context.Context, vaultID, userID string) ([]VaultKey, error) {
	// The LEFT JOIN yields one all-NULL key row for a member without keys,
	// and no row at all for a non-member.
	rows, err := s.db.QueryContext(ctx,
		`SELECT k.epoch, k.sealed_key FROM vault_members m
		 LEFT JOIN vault_keys k ON k.vault_id = m.vault_id AND k.user_id = m.user_id
		 WHERE m.vault_id = ? AND m.user_id = ? ORDER BY k.epoch`, vaultID, userID)
	if err != nil {
		return nil, fmt.Errorf("vault keys: %w", err)
	}
	defer rows.Close()
	member := false
	out := []VaultKey{}
	for rows.Next() {
		member = true
		var epoch sql.NullInt64
		var sealed []byte
		if err := rows.Scan(&epoch, &sealed); err != nil {
			return nil, fmt.Errorf("scan vault key: %w", err)
		}
		if epoch.Valid {
			out = append(out, VaultKey{Epoch: int(epoch.Int64), SealedKey: sealed})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("vault keys: %w", err)
	}
	if !member {
		return nil, ErrNotFound
	}
	return out, nil
}

// UsageBytes is the stored chunk bytes (history included) of every vault the
// user owns. Shared vaults count against their owner.
func (s *Store) UsageBytes(ctx context.Context, ownerID string) (int64, error) {
	var n int64
	if err := s.db.QueryRowContext(ctx,
		`SELECT COALESCE(SUM(bytes_used), 0) FROM vaults WHERE owner_id = ?`, ownerID).Scan(&n); err != nil {
		return 0, fmt.Errorf("usage: %w", err)
	}
	return n, nil
}
