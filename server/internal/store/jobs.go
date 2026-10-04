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

// ReleaseLease gives up the named lease if holder still holds it, so another
// replica (or a restarted process) can take it at once.
func (s *Store) ReleaseLease(ctx context.Context, name, holder string) error {
	if _, err := s.db.ExecContext(ctx,
		`DELETE FROM job_leases WHERE name = ? AND holder = ?`, name, holder); err != nil {
		return fmt.Errorf("release lease: %w", err)
	}
	return nil
}

// PrunePolicy says which versions retention removes. Heads that are not
// tombstones are never removed, and while a file's head is a tombstone its
// last content version (the one a restore needs) is removed only by trash
// purge.
type PrunePolicy struct {
	// HistoryCutoffMs: a non-head version is deleted once the version that
	// superseded it was written before this. 0 = no age limit.
	HistoryCutoffMs int64
	// MaxVersions: keep at most this many versions per file, not counting a
	// tombstone head. 0 = no count limit.
	MaxVersions int
	// TrashCutoffMs: a file whose tombstone head was written before this
	// loses every earlier version. The tombstone itself stays as the head so
	// devices that were offline still learn about the deletion. 0 = never.
	TrashCutoffMs int64
}

type PruneStats struct {
	VersionsDeleted int
	FilesPurged     int
}

// The predicates below are evaluated per row of the versions table, which
// they reference unaliased as "versions".

// notHead matches versions that are not their file's current head.
const notHead = `NOT EXISTS (SELECT 1 FROM files f
  WHERE f.vault_id = versions.vault_id AND f.file_id = versions.file_id AND f.head_version_id = versions.version_id)`

// notRestorable excludes, for a file whose head is a tombstone, the newest
// content version: the one restoring the file from the trash brings back.
const notRestorable = `NOT (versions.deleted = 0
  AND EXISTS (SELECT 1 FROM files f JOIN versions h ON h.vault_id = f.vault_id AND h.version_id = f.head_version_id
              WHERE f.vault_id = versions.vault_id AND f.file_id = versions.file_id AND h.deleted = 1)
  AND NOT EXISTS (SELECT 1 FROM versions p
                  WHERE p.vault_id = versions.vault_id AND p.file_id = versions.file_id
                    AND p.deleted = 0 AND p.seq > versions.seq))`

// supersededBefore matches versions whose successor was written before the
// cutoff, passed twice. The first comparison only lets versions_created
// narrow the candidates: nothing is superseded before it is written.
const supersededBefore = `versions.created_at < ? AND (SELECT n.created_at FROM versions n
   WHERE n.vault_id = versions.vault_id AND n.file_id = versions.file_id AND n.seq > versions.seq
   ORDER BY n.seq LIMIT 1) < ?`

// beyondMaxVersions matches versions outside the newest ? of their file,
// ranking every version except a tombstone head.
const beyondMaxVersions = `(versions.vault_id, versions.version_id) IN (
   SELECT vault_id, version_id FROM (
     SELECT v.vault_id, v.version_id,
            ROW_NUMBER() OVER (PARTITION BY v.vault_id, v.file_id ORDER BY v.seq DESC) AS rn
     FROM versions v
     WHERE NOT (v.deleted = 1 AND EXISTS (SELECT 1 FROM files f
       WHERE f.vault_id = v.vault_id AND f.file_id = v.file_id AND f.head_version_id = v.version_id)))
   WHERE rn > ?)`

func (s *Store) Prune(ctx context.Context, p PrunePolicy) (PruneStats, error) {
	var stats PruneStats
	if p.TrashCutoffMs > 0 {
		purged, err := s.purgeTrash(ctx, p.TrashCutoffMs)
		stats.FilesPurged = purged
		if err != nil {
			return stats, err
		}
	}
	if p.HistoryCutoffMs > 0 {
		n, err := s.deleteVersions(ctx, supersededBefore+` AND `+notHead+` AND `+notRestorable,
			p.HistoryCutoffMs, p.HistoryCutoffMs)
		if err != nil {
			return stats, err
		}
		stats.VersionsDeleted += n
	}
	if p.MaxVersions > 0 {
		n, err := s.deleteVersions(ctx, beyondMaxVersions+` AND `+notHead+` AND `+notRestorable, p.MaxVersions)
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

// purgeTrash empties the trash of files deleted before cutoffMs: every
// version but the tombstone head goes, with its chunk references. The files
// row and the tombstone stay, so Heads and Changes keep reporting the
// deletion, and the file can be re-created with the tombstone as its base.
// It returns the number of files purged.
func (s *Store) purgeTrash(ctx context.Context, cutoffMs int64) (int, error) {
	type target struct {
		vaultID      string
		fileID, head []byte
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT f.vault_id, f.file_id, f.head_version_id FROM files f
		 JOIN versions v ON v.vault_id = f.vault_id AND v.version_id = f.head_version_id
		 WHERE v.deleted = 1 AND v.created_at < ?
		   AND EXISTS (SELECT 1 FROM versions o
		               WHERE o.vault_id = f.vault_id AND o.file_id = f.file_id AND o.version_id != f.head_version_id)`,
		cutoffMs)
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
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, fmt.Errorf("find expired trash: %w", err)
	}
	// Close before the transactions below: a local database has one connection.
	if err := rows.Close(); err != nil {
		return 0, err
	}

	purged := 0
	for _, tg := range targets {
		err := s.withTx(ctx, func(tx *sql.Tx) error {
			// A no-op write takes the write lock first (see commitTx) and
			// checks the file was not re-created since the scan.
			res, err := tx.ExecContext(ctx,
				`UPDATE files SET head_version_id = head_version_id WHERE vault_id = ? AND file_id = ? AND head_version_id = ?`,
				tg.vaultID, tg.fileID, tg.head)
			if err != nil {
				return fmt.Errorf("lock file: %w", err)
			}
			n, err := res.RowsAffected()
			if err != nil {
				return fmt.Errorf("lock file: %w", err)
			}
			if n == 0 {
				return nil // re-created since the scan
			}
			if _, err := tx.ExecContext(ctx,
				`DELETE FROM version_chunks WHERE vault_id = ? AND version_id IN
				 (SELECT version_id FROM versions WHERE vault_id = ? AND file_id = ? AND version_id != ?)`,
				tg.vaultID, tg.vaultID, tg.fileID, tg.head); err != nil {
				return fmt.Errorf("purge chunk refs: %w", err)
			}
			res, err = tx.ExecContext(ctx,
				`DELETE FROM versions WHERE vault_id = ? AND file_id = ? AND version_id != ?`,
				tg.vaultID, tg.fileID, tg.head)
			if err != nil {
				return fmt.Errorf("purge versions: %w", err)
			}
			if n, err = res.RowsAffected(); err != nil {
				return fmt.Errorf("purge versions: %w", err)
			}
			if n > 0 {
				purged++
			}
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
