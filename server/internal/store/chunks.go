package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

type Chunk struct {
	VaultID string
	ChunkID []byte
	BlobKey string // unique per upload, see Task 6 notes
	Size    int64  // ciphertext bytes
}

// InsertChunk records an uploaded chunk and adds its size to the vault's
// usage. It returns false when the chunk was already recorded; the caller
// must then delete the blob it just wrote. A new chunk that would take the
// vault owner's usage (across all their vaults) past their quota is not
// recorded and ErrQuotaExceeded is returned; the check and the insert share
// one transaction, so concurrent uploads cannot overshoot the quota.
// ErrNotFound means the vault does not exist.
func (s *Store) InsertChunk(ctx context.Context, c Chunk) (bool, error) {
	var inserted bool
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		// Write first so the transaction holds the write lock before it
		// reads usage (see commitTx).
		res, err := tx.ExecContext(ctx,
			`INSERT OR IGNORE INTO chunks (vault_id, chunk_id, blob_key, size, touched_at) VALUES (?, ?, ?, ?, ?)`,
			c.VaultID, c.ChunkID, c.BlobKey, c.Size, s.nowMs())
		if err != nil {
			return fmt.Errorf("insert chunk: %w", err)
		}
		n, err := res.RowsAffected()
		if err != nil {
			return fmt.Errorf("insert chunk: %w", err)
		}
		if n == 0 {
			// Already recorded: restart its garbage-collection grace period
			// so it survives until the client commits, as TouchChunks does.
			if _, err := tx.ExecContext(ctx,
				`UPDATE chunks SET touched_at = ? WHERE vault_id = ? AND chunk_id = ?`,
				s.nowMs(), c.VaultID, c.ChunkID); err != nil {
				return fmt.Errorf("touch chunk: %w", err)
			}
			return nil
		}
		var ownerID string
		var quota int64
		err = tx.QueryRowContext(ctx,
			`SELECT u.id, u.quota_bytes FROM vaults v JOIN users u ON u.id = v.owner_id WHERE v.id = ?`,
			c.VaultID).Scan(&ownerID, &quota)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("load vault owner: %w", err)
		}
		var used int64
		if err := tx.QueryRowContext(ctx,
			`SELECT COALESCE(SUM(bytes_used), 0) FROM vaults WHERE owner_id = ?`, ownerID).Scan(&used); err != nil {
			return fmt.Errorf("usage: %w", err)
		}
		if used+c.Size > quota {
			return ErrQuotaExceeded // rolls back the insert
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE vaults SET bytes_used = bytes_used + ? WHERE id = ?`, c.Size, c.VaultID); err != nil {
			return fmt.Errorf("add usage: %w", err)
		}
		inserted = true
		return nil
	})
	if err != nil {
		return false, err
	}
	return inserted, nil
}

// TouchChunks reports which chunks exist and refreshes their touched_at, so
// garbage collection leaves them alone while the client commits.
func (s *Store) TouchChunks(ctx context.Context, vaultID string, chunkIDs [][]byte) ([]bool, error) {
	exists := make([]bool, len(chunkIDs))
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		now := s.nowMs()
		for i, id := range chunkIDs {
			res, err := tx.ExecContext(ctx,
				`UPDATE chunks SET touched_at = ? WHERE vault_id = ? AND chunk_id = ?`, now, vaultID, id)
			if err != nil {
				return fmt.Errorf("touch chunk: %w", err)
			}
			n, err := res.RowsAffected()
			if err != nil {
				return fmt.Errorf("touch chunk: %w", err)
			}
			exists[i] = n == 1
		}
		return nil
	})
	return exists, err
}

// ChunkBlob returns the blob key and stored size of a chunk.
func (s *Store) ChunkBlob(ctx context.Context, vaultID string, chunkID []byte) (key string, size int64, err error) {
	err = s.db.QueryRowContext(ctx,
		`SELECT blob_key, size FROM chunks WHERE vault_id = ? AND chunk_id = ?`, vaultID, chunkID).Scan(&key, &size)
	if errors.Is(err, sql.ErrNoRows) {
		return "", 0, ErrNotFound
	}
	if err != nil {
		return "", 0, fmt.Errorf("chunk blob: %w", err)
	}
	return key, size, nil
}
