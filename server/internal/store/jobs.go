package store

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// AcquireLease takes or renews the named lease for holder until now+ttl.
// It returns false while another holder's lease is unexpired.
func (s *Store) AcquireLease(ctx context.Context, name, holder string, ttl time.Duration) (bool, error) {
	now := s.nowMs()
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO job_leases (name, holder, expires_at) VALUES (?, ?, ?)
		 ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
		 WHERE job_leases.expires_at < ? OR job_leases.holder = excluded.holder`,
		name, holder, now+ttl.Milliseconds(), now)
	if err != nil {
		return false, fmt.Errorf("acquire lease: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("acquire lease: %w", err)
	}
	return n == 1, nil
}

type PrunePolicy struct {
	HistoryCutoffMs int64 // non-head versions created before this are deleted
	MaxVersions     int   // keep at most this many versions per file; 0 = no limit
	TrashCutoffMs   int64 // files deleted before this are purged entirely
}

type PruneStats struct {
	VersionsDeleted int
	FilesPurged     int
}

// notHead matches versions rows that are not their file's current head.
const notHead = `NOT EXISTS (SELECT 1 FROM files f WHERE f.vault_id = versions.vault_id AND f.head_version_id = versions.version_id)`

func (s *Store) Prune(ctx context.Context, p PrunePolicy) (PruneStats, error) {
	var stats PruneStats
	purged, err := s.purgeTrash(ctx, p.TrashCutoffMs)
	if err != nil {
		return stats, err
	}
	stats.FilesPurged = purged

	n, err := s.deleteVersions(ctx, `created_at < ? AND `+notHead, p.HistoryCutoffMs)
	if err != nil {
		return stats, err
	}
	stats.VersionsDeleted += n

	if p.MaxVersions > 0 {
		n, err = s.deleteVersions(ctx,
			`(vault_id, version_id) IN (
			   SELECT vault_id, version_id FROM (
			     SELECT vault_id, version_id,
			            ROW_NUMBER() OVER (PARTITION BY vault_id, file_id ORDER BY seq DESC) AS rn
			     FROM versions)
			   WHERE rn > ?) AND `+notHead, p.MaxVersions)
		if err != nil {
			return stats, err
		}
		stats.VersionsDeleted += n
	}
	return stats, nil
}

// deleteVersions deletes the versions matching where (a predicate over the
// versions table) and their chunk references, in one transaction.
func (s *Store) deleteVersions(ctx context.Context, where string, args ...any) (int, error) {
	var deleted int64
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx,
			`DELETE FROM version_chunks WHERE (vault_id, version_id) IN (SELECT vault_id, version_id FROM versions WHERE `+where+`)`,
			args...); err != nil {
			return fmt.Errorf("delete chunk refs: %w", err)
		}
		res, err := tx.ExecContext(ctx, `DELETE FROM versions WHERE `+where, args...)
		if err != nil {
			return fmt.Errorf("delete versions: %w", err)
		}
		deleted, err = res.RowsAffected()
		return err
	})
	return int(deleted), err
}

func (s *Store) purgeTrash(ctx context.Context, cutoffMs int64) (int, error) {
	type target struct {
		vaultID      string
		fileID, head []byte
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT f.vault_id, f.file_id, f.head_version_id FROM files f
		 JOIN versions v ON v.vault_id = f.vault_id AND v.version_id = f.head_version_id
		 WHERE v.deleted = 1 AND v.created_at < ?`, cutoffMs)
	if err != nil {
		return 0, fmt.Errorf("find expired trash: %w", err)
	}
	var targets []target
	for rows.Next() {
		var tg target
		if err := rows.Scan(&tg.vaultID, &tg.fileID, &tg.head); err != nil {
			rows.Close()
			return 0, fmt.Errorf("scan trash: %w", err)
		}
		targets = append(targets, tg)
	}
	// Close before the transactions below: a local database has one connection.
	if err := rows.Close(); err != nil {
		return 0, err
	}

	purged := 0
	for _, tg := range targets {
		err := s.withTx(ctx, func(tx *sql.Tx) error {
			res, err := tx.ExecContext(ctx,
				`DELETE FROM files WHERE vault_id = ? AND file_id = ? AND head_version_id = ?`, tg.vaultID, tg.fileID, tg.head)
			if err != nil {
				return fmt.Errorf("purge file: %w", err)
			}
			n, err := res.RowsAffected()
			if err != nil {
				return fmt.Errorf("purge file: %w", err)
			}
			if n == 0 {
				return nil // re-created since the scan
			}
			if _, err := tx.ExecContext(ctx,
				`DELETE FROM version_chunks WHERE vault_id = ? AND version_id IN
				 (SELECT version_id FROM versions WHERE vault_id = ? AND file_id = ?)`,
				tg.vaultID, tg.vaultID, tg.fileID); err != nil {
				return fmt.Errorf("purge chunk refs: %w", err)
			}
			if _, err := tx.ExecContext(ctx,
				`DELETE FROM versions WHERE vault_id = ? AND file_id = ?`, tg.vaultID, tg.fileID); err != nil {
				return fmt.Errorf("purge versions: %w", err)
			}
			purged++
			return nil
		})
		if err != nil {
			return purged, err
		}
	}
	return purged, nil
}

type DeadChunk struct {
	VaultID string
	ChunkID []byte
	BlobKey string
	Size    int64
}

const unreferenced = `NOT EXISTS (SELECT 1 FROM version_chunks vc WHERE vc.vault_id = chunks.vault_id AND vc.chunk_id = chunks.chunk_id)`

// DeadChunks lists up to limit chunks that no version references and that
// were last touched before touchedBeforeMs.
func (s *Store) DeadChunks(ctx context.Context, touchedBeforeMs int64, limit int) ([]DeadChunk, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT vault_id, chunk_id, blob_key, size FROM chunks WHERE touched_at < ? AND `+unreferenced+` LIMIT ?`,
		touchedBeforeMs, limit)
	if err != nil {
		return nil, fmt.Errorf("dead chunks: %w", err)
	}
	defer rows.Close()
	var out []DeadChunk
	for rows.Next() {
		var c DeadChunk
		if err := rows.Scan(&c.VaultID, &c.ChunkID, &c.BlobKey, &c.Size); err != nil {
			return nil, fmt.Errorf("scan dead chunk: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// DeleteDeadChunk deletes c's row if it is still dead and subtracts its size
// from the vault's usage. The caller deletes the blob afterwards.
func (s *Store) DeleteDeadChunk(ctx context.Context, c DeadChunk, touchedBeforeMs int64) (bool, error) {
	var deleted bool
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx,
			`DELETE FROM chunks WHERE vault_id = ? AND chunk_id = ? AND touched_at < ? AND `+unreferenced,
			c.VaultID, c.ChunkID, touchedBeforeMs)
		if err != nil {
			return fmt.Errorf("delete chunk: %w", err)
		}
		n, err := res.RowsAffected()
		if err != nil {
			return fmt.Errorf("delete chunk: %w", err)
		}
		if n == 0 {
			return nil
		}
		deleted = true
		if _, err := tx.ExecContext(ctx,
			`UPDATE vaults SET bytes_used = bytes_used - ? WHERE id = ?`, c.Size, c.VaultID); err != nil {
			return fmt.Errorf("reduce usage: %w", err)
		}
		return nil
	})
	return deleted, err
}
