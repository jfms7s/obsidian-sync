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
// must then delete the blob it just wrote.
func (s *Store) InsertChunk(ctx context.Context, c Chunk) (bool, error) {
	var inserted bool
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx,
			`INSERT OR IGNORE INTO chunks (vault_id, chunk_id, blob_key, size, touched_at) VALUES (?, ?, ?, ?, ?)`,
			c.VaultID, c.ChunkID, c.BlobKey, c.Size, s.nowMs())
		if err != nil {
			return fmt.Errorf("insert chunk: %w", err)
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return nil
		}
		inserted = true
		if _, err := tx.ExecContext(ctx,
			`UPDATE vaults SET bytes_used = bytes_used + ? WHERE id = ?`, c.Size, c.VaultID); err != nil {
			return fmt.Errorf("add usage: %w", err)
		}
		return nil
	})
	return inserted, err
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
			n, _ := res.RowsAffected()
			exists[i] = n == 1
		}
		return nil
	})
	return exists, err
}

func (s *Store) ChunkBlobKey(ctx context.Context, vaultID string, chunkID []byte) (string, error) {
	var key string
	err := s.db.QueryRowContext(ctx,
		`SELECT blob_key FROM chunks WHERE vault_id = ? AND chunk_id = ?`, vaultID, chunkID).Scan(&key)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("chunk blob key: %w", err)
	}
	return key, nil
}
