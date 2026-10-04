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
	if v.Deleted && len(v.ChunkIDs) > 0 {
		return CommitOutcome{Reason: CommitInvalid, Detail: "a deletion carries no chunks"}, nil
	}

	// Take the write lock before reading anything. A deferred transaction
	// that reads first holds a snapshot; if another connection commits in
	// the meantime, upgrading to a writer fails at once with "database is
	// locked" and busy_timeout cannot help. A no-op write waits for the lock
	// instead and starts the transaction on the latest data.
	res, err := tx.ExecContext(ctx, `UPDATE vaults SET seq = seq WHERE id = ?`, v.VaultID)
	if err != nil {
		return CommitOutcome{}, fmt.Errorf("lock vault: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return CommitOutcome{}, fmt.Errorf("lock vault: %w", err)
	}
	if n == 0 {
		return CommitOutcome{}, ErrNotFound
	}

	prev, err := versionTx(ctx, tx, v.VaultID, v.VersionID)
	switch {
	case err == nil && sameContent(prev, v):
		// A retry of a commit that already succeeded but whose response was lost.
		return CommitOutcome{Reason: CommitOK, Seq: prev.Seq}, nil
	case err == nil && !bytes.Equal(prev.FileID, v.FileID):
		return CommitOutcome{Reason: CommitInvalid, Detail: "version_id is already used by another file"}, nil
	case err == nil:
		return CommitOutcome{Reason: CommitInvalid, Detail: "version_id reused with different content"}, nil
	case !errors.Is(err, sql.ErrNoRows):
		return CommitOutcome{}, fmt.Errorf("look up version: %w", err)
	}

	var epoch int
	if err := tx.QueryRowContext(ctx, `SELECT current_epoch FROM vaults WHERE id = ?`, v.VaultID).Scan(&epoch); err != nil {
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
		// Touching a referenced chunk both proves it exists and restarts its
		// garbage-collection grace period.
		res, err := tx.ExecContext(ctx,
			`UPDATE chunks SET touched_at = ? WHERE vault_id = ? AND chunk_id = ?`, now, v.VaultID, id)
		if err != nil {
			return CommitOutcome{}, fmt.Errorf("touch chunk: %w", err)
		}
		n, err := res.RowsAffected()
		if err != nil {
			return CommitOutcome{}, fmt.Errorf("touch chunk: %w", err)
		}
		if n == 0 {
			return CommitOutcome{Reason: CommitMissingChunk}, nil
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

// versionTx reads one version and its ordered chunk list inside tx.
func versionTx(ctx context.Context, tx *sql.Tx, vaultID string, versionID []byte) (Version, error) {
	v := Version{VaultID: vaultID, VersionID: versionID}
	var deleted int64
	err := tx.QueryRowContext(ctx,
		`SELECT file_id, base_version_id, epoch, size, deleted, seq FROM versions WHERE vault_id = ? AND version_id = ?`,
		vaultID, versionID).Scan(&v.FileID, &v.BaseVersionID, &v.Epoch, &v.Size, &deleted, &v.Seq)
	if err != nil {
		return Version{}, err
	}
	v.Deleted = deleted != 0
	rows, err := tx.QueryContext(ctx,
		`SELECT chunk_id FROM version_chunks WHERE vault_id = ? AND version_id = ? ORDER BY idx`, vaultID, versionID)
	if err != nil {
		return Version{}, fmt.Errorf("read chunk refs: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id []byte
		if err := rows.Scan(&id); err != nil {
			return Version{}, fmt.Errorf("scan chunk ref: %w", err)
		}
		v.ChunkIDs = append(v.ChunkIDs, id)
	}
	if err := rows.Err(); err != nil {
		return Version{}, fmt.Errorf("read chunk refs: %w", err)
	}
	return v, nil
}

// sameContent reports whether a commit carries the same version as a stored
// one. enc_meta is ignored: a client that re-encrypts uses a fresh nonce.
func sameContent(stored, v Version) bool {
	if !bytes.Equal(stored.FileID, v.FileID) || !bytes.Equal(stored.BaseVersionID, v.BaseVersionID) ||
		stored.Epoch != v.Epoch || stored.Size != v.Size || stored.Deleted != v.Deleted ||
		len(stored.ChunkIDs) != len(v.ChunkIDs) {
		return false
	}
	for i := range stored.ChunkIDs {
		if !bytes.Equal(stored.ChunkIDs[i], v.ChunkIDs[i]) {
			return false
		}
	}
	return true
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

// errBadLimit guards paging: SQLite reads a negative LIMIT as "no limit".
var errBadLimit = errors.New("store: page limit must be positive")

// Changes returns up to limit versions with seq > since, oldest first.
func (s *Store) Changes(ctx context.Context, vaultID string, since int64, limit int) ([]Version, error) {
	if limit <= 0 {
		return nil, errBadLimit
	}
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
		 JOIN files f ON f.vault_id = ver.vault_id AND f.file_id = ver.file_id AND f.head_version_id = ver.version_id
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
	if limit <= 0 {
		return nil, errBadLimit
	}
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
