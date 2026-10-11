package store

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
)

// Snapshot writes a consistent copy of the whole database to path with
// VACUUM INTO, in one read transaction. It refuses (ErrExists) when path
// already exists. On a remote database the file would be written on the
// database server, so callers use it only with a local file.
func (s *Store) Snapshot(ctx context.Context, path string) error {
	if _, err := os.Lstat(path); err == nil {
		return fmt.Errorf("%w: %s", ErrExists, path)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("snapshot: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, `VACUUM INTO ?`, path); err != nil {
		return fmt.Errorf("snapshot: %w", err)
	}
	return nil
}

// ChunkRef is one stored chunk and the blob that holds it.
type ChunkRef struct {
	VaultID string
	ChunkID []byte
	BlobKey string
	Size    int64
}

// ChunkRefs lists every chunk row, committed or not, ordered by blob key.
func (s *Store) ChunkRefs(ctx context.Context) ([]ChunkRef, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT vault_id, chunk_id, blob_key, size FROM chunks ORDER BY blob_key`)
	if err != nil {
		return nil, fmt.Errorf("list chunks: %w", err)
	}
	defer rows.Close()
	var out []ChunkRef
	for rows.Next() {
		var c ChunkRef
		if err := rows.Scan(&c.VaultID, &c.ChunkID, &c.BlobKey, &c.Size); err != nil {
			return nil, fmt.Errorf("scan chunk: %w", err)
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list chunks: %w", err)
	}
	return out, nil
}

// ExportCounts summarises a database for a backup manifest.
type ExportCounts struct {
	SchemaVersion int64 `json:"schema_version"`
	Users         int64 `json:"users"`
	Vaults        int64 `json:"vaults"`
	Versions      int64 `json:"versions"`
	Chunks        int64 `json:"chunks"`
	ChunkBytes    int64 `json:"chunk_bytes"`
}

func (s *Store) ExportCounts(ctx context.Context) (ExportCounts, error) {
	var c ExportCounts
	err := s.db.QueryRowContext(ctx, `SELECT
		(SELECT COALESCE(MAX(version), 0) FROM schema_migrations),
		(SELECT COUNT(*) FROM users),
		(SELECT COUNT(*) FROM vaults),
		(SELECT COUNT(*) FROM versions),
		(SELECT COUNT(*) FROM chunks),
		(SELECT COALESCE(SUM(size), 0) FROM chunks)`).
		Scan(&c.SchemaVersion, &c.Users, &c.Vaults, &c.Versions, &c.Chunks, &c.ChunkBytes)
	if err != nil {
		return ExportCounts{}, fmt.Errorf("count rows: %w", err)
	}
	return c, nil
}
