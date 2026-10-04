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
// stores the owner's sealed keys.
func (s *Store) CreateVault(ctx context.Context, v Vault, keys []VaultKey) error {
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

func (s *Store) VaultKeys(ctx context.Context, vaultID, userID string) ([]VaultKey, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT epoch, sealed_key FROM vault_keys WHERE vault_id = ? AND user_id = ? ORDER BY epoch`, vaultID, userID)
	if err != nil {
		return nil, fmt.Errorf("vault keys: %w", err)
	}
	defer rows.Close()
	var out []VaultKey
	for rows.Next() {
		var k VaultKey
		if err := rows.Scan(&k.Epoch, &k.SealedKey); err != nil {
			return nil, fmt.Errorf("scan vault key: %w", err)
		}
		out = append(out, k)
	}
	return out, rows.Err()
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
