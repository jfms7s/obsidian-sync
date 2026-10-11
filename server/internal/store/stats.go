package store

import (
	"context"
	"fmt"
)

// ServerStats are server-wide counts for monitoring.
type ServerStats struct {
	Users            int64
	Vaults           int64
	DevicesActive    int64 // not revoked
	StorageUsedBytes int64 // over every vault, history and trash included
}

func (s *Store) ServerStats(ctx context.Context) (ServerStats, error) {
	var st ServerStats
	err := s.db.QueryRowContext(ctx, `SELECT
		(SELECT COUNT(*) FROM users),
		(SELECT COUNT(*) FROM vaults),
		(SELECT COUNT(*) FROM devices WHERE revoked_at = 0),
		(SELECT COALESCE(SUM(bytes_used), 0) FROM vaults)`).
		Scan(&st.Users, &st.Vaults, &st.DevicesActive, &st.StorageUsedBytes)
	if err != nil {
		return ServerStats{}, fmt.Errorf("server stats: %w", err)
	}
	return st, nil
}
