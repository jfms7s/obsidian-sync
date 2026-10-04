package store

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
)

type Version struct {
	VaultID       string
	FileID        []byte
	VersionID     []byte
	BaseVersionID []byte // nil = the client believes the file is new
	Epoch         int
	EncMeta       []byte
	ChunkIDs      [][]byte
	Size          int64
	Deleted       bool
	DeviceID      string
	CreatedAtMs   int64
	Seq           int64
}

type CommitReason int

const (
	CommitOK CommitReason = iota
	CommitConflict
	CommitStaleEpoch
	CommitMissingChunk
	CommitInvalid
)

type CommitOutcome struct {
	Reason        CommitReason
	Seq           int64  // with CommitOK
	HeadVersionID []byte // with CommitConflict: the current head, nil if the file does not exist
	Detail        string // with CommitInvalid
}

func (o CommitOutcome) OK() bool { return o.Reason == CommitOK }

// Commit applies one version under optimistic concurrency. Rejections are
// returned as an outcome; the error is only for infrastructure failures and
// ErrNotFound when the vault does not exist.
func (s *Store) Commit(ctx context.Context, v Version) (CommitOutcome, error) {
	var out CommitOutcome
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		var err error
		out, err = commitTx(ctx, tx, v, s.nowMs())
		return err
	})
	return out, err
}

func commitTx(ctx context.Context, tx *sql.Tx, v Version, now int64) (CommitOutcome, error) {
	var prevFile []byte
	var prevSeq int64
	err := tx.QueryRowContext(ctx,
		`SELECT file_id, seq FROM versions WHERE vault_id = ? AND version_id = ?`, v.VaultID, v.VersionID).
		Scan(&prevFile, &prevSeq)
	switch {
	case err == nil && bytes.Equal(prevFile, v.FileID):
		// A retry of a commit that already succeeded but whose response was lost.
		return CommitOutcome{Reason: CommitOK, Seq: prevSeq}, nil
	case err == nil:
		return CommitOutcome{Reason: CommitInvalid, Detail: "version_id is already used by another file"}, nil
	case !errors.Is(err, sql.ErrNoRows):
		return CommitOutcome{}, fmt.Errorf("look up version: %w", err)
	}

	var epoch int
	err = tx.QueryRowContext(ctx, `SELECT current_epoch FROM vaults WHERE id = ?`, v.VaultID).Scan(&epoch)
	if errors.Is(err, sql.ErrNoRows) {
		return CommitOutcome{}, ErrNotFound
	}
	if err != nil {
		return CommitOutcome{}, fmt.Errorf("read vault: %w", err)
	}
	if v.Epoch != epoch {
		return CommitOutcome{Reason: CommitStaleEpoch}, nil
	}

	var head []byte
	err = tx.QueryRowContext(ctx,
		`SELECT head_version_id FROM files WHERE vault_id = ? AND file_id = ?`, v.VaultID, v.FileID).Scan(&head)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return CommitOutcome{}, fmt.Errorf("read head: %w", err)
	}
	fileExists := err == nil
	if !bytes.Equal(head, v.BaseVersionID) {
		return CommitOutcome{Reason: CommitConflict, HeadVersionID: head}, nil
	}
	if !fileExists && v.Deleted {
		return CommitOutcome{Reason: CommitInvalid, Detail: "cannot delete a file the server does not have"}, nil
	}
	for _, id := range v.ChunkIDs {
		var one int
		err := tx.QueryRowContext(ctx,
			`SELECT 1 FROM chunks WHERE vault_id = ? AND chunk_id = ?`, v.VaultID, id).Scan(&one)
		if errors.Is(err, sql.ErrNoRows) {
			return CommitOutcome{Reason: CommitMissingChunk}, nil
		}
		if err != nil {
			return CommitOutcome{}, fmt.Errorf("check chunk: %w", err)
		}
	}

	var seq int64
	if err := tx.QueryRowContext(ctx,
		`UPDATE vaults SET seq = seq + 1 WHERE id = ? RETURNING seq`, v.VaultID).Scan(&seq); err != nil {
		return CommitOutcome{}, fmt.Errorf("advance seq: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO versions (vault_id, version_id, file_id, base_version_id, epoch, enc_meta, size, deleted, device_id, created_at, seq)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		v.VaultID, v.VersionID, v.FileID, nonNil(v.BaseVersionID), v.Epoch, v.EncMeta, v.Size, boolInt(v.Deleted),
		v.DeviceID, now, seq); err != nil {
		return CommitOutcome{}, fmt.Errorf("insert version: %w", err)
	}
	for i, id := range v.ChunkIDs {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO version_chunks (vault_id, version_id, idx, chunk_id) VALUES (?, ?, ?, ?)`,
			v.VaultID, v.VersionID, i, id); err != nil {
			return CommitOutcome{}, fmt.Errorf("insert chunk ref: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO files (vault_id, file_id, head_version_id) VALUES (?, ?, ?)
		 ON CONFLICT (vault_id, file_id) DO UPDATE SET head_version_id = excluded.head_version_id`,
		v.VaultID, v.FileID, v.VersionID); err != nil {
		return CommitOutcome{}, fmt.Errorf("set head: %w", err)
	}
	return CommitOutcome{Reason: CommitOK, Seq: seq}, nil
}

// versionQuery joins a version subquery (which must select every versions
// column) with its chunk references, one row per chunk.
const versionQuery = `SELECT v.version_id, v.file_id, v.base_version_id, v.epoch, v.enc_meta, v.size, v.deleted,
       v.device_id, v.created_at, v.seq, vc.chunk_id
FROM (%s) v
LEFT JOIN version_chunks vc ON vc.vault_id = v.vault_id AND vc.version_id = v.version_id
ORDER BY %s, vc.idx`

func (s *Store) queryVersions(ctx context.Context, vaultID, inner, order string, args ...any) ([]Version, error) {
	rows, err := s.db.QueryContext(ctx, fmt.Sprintf(versionQuery, inner, order), args...)
	if err != nil {
		return nil, fmt.Errorf("query versions: %w", err)
	}
	defer rows.Close()
	var out []Version
	for rows.Next() {
		var v Version
		var deleted int64
		var chunkID []byte
		if err := rows.Scan(&v.VersionID, &v.FileID, &v.BaseVersionID, &v.Epoch, &v.EncMeta, &v.Size, &deleted,
			&v.DeviceID, &v.CreatedAtMs, &v.Seq, &chunkID); err != nil {
			return nil, fmt.Errorf("scan version: %w", err)
		}
		if n := len(out); n > 0 && bytes.Equal(out[n-1].VersionID, v.VersionID) {
			out[n-1].ChunkIDs = append(out[n-1].ChunkIDs, chunkID)
			continue
		}
		v.VaultID = vaultID
		v.Deleted = deleted != 0
		if len(v.BaseVersionID) == 0 {
			v.BaseVersionID = nil
		}
		if chunkID != nil {
			v.ChunkIDs = [][]byte{chunkID}
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// Changes returns up to limit versions with seq > since, oldest first.
func (s *Store) Changes(ctx context.Context, vaultID string, since int64, limit int) ([]Version, error) {
	return s.queryVersions(ctx, vaultID,
		`SELECT * FROM versions WHERE vault_id = ? AND seq > ? ORDER BY seq LIMIT ?`, "v.seq",
		vaultID, since, limit)
}

// History returns every retained version of one file, newest first.
func (s *Store) History(ctx context.Context, vaultID string, fileID []byte) ([]Version, error) {
	return s.queryVersions(ctx, vaultID,
		`SELECT * FROM versions WHERE vault_id = ? AND file_id = ?`, "v.seq DESC",
		vaultID, fileID)
}

// Trash returns the tombstone heads of deleted files, newest first.
func (s *Store) Trash(ctx context.Context, vaultID string) ([]Version, error) {
	return s.queryVersions(ctx, vaultID,
		`SELECT ver.* FROM versions ver
		 JOIN files f ON f.vault_id = ver.vault_id AND f.head_version_id = ver.version_id
		 WHERE ver.vault_id = ? AND ver.deleted = 1`, "v.seq DESC",
		vaultID)
}

type Head struct {
	FileID    []byte
	VersionID []byte
	Seq       int64
	Deleted   bool
}

// Heads pages through every file's head in file_id order, starting after
// `after` (nil = from the start).
func (s *Store) Heads(ctx context.Context, vaultID string, after []byte, limit int) ([]Head, error) {
	q := `SELECT f.file_id, f.head_version_id, v.seq, v.deleted FROM files f
	      JOIN versions v ON v.vault_id = f.vault_id AND v.version_id = f.head_version_id
	      WHERE f.vault_id = ?`
	args := []any{vaultID}
	if len(after) > 0 {
		q += ` AND f.file_id > ?`
		args = append(args, after)
	}
	q += ` ORDER BY f.file_id LIMIT ?`
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("heads: %w", err)
	}
	defer rows.Close()
	var out []Head
	for rows.Next() {
		var h Head
		var deleted int64
		if err := rows.Scan(&h.FileID, &h.VersionID, &h.Seq, &deleted); err != nil {
			return nil, fmt.Errorf("scan head: %w", err)
		}
		h.Deleted = deleted != 0
		out = append(out, h)
	}
	return out, rows.Err()
}
