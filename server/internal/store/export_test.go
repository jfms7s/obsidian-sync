package store

import (
	"context"
	"database/sql"
)

// DBStats exposes the pool statistics to the external tests.
func DBStats(s *Store) sql.DBStats { return s.db.Stats() }

// PragmaInt reads an integer pragma on the store's connection.
func PragmaInt(ctx context.Context, s *Store, name string) (int64, error) {
	var v int64
	err := s.db.QueryRowContext(ctx, "PRAGMA "+name).Scan(&v)
	return v, err
}
