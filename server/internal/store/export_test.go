package store

import (
	"context"
	"database/sql"
	"testing"
)

// DBStats exposes the pool statistics to the external tests.
func DBStats(s *Store) sql.DBStats { return s.db.Stats() }

// PragmaInt reads an integer pragma on the store's connection.
func PragmaInt(ctx context.Context, s *Store, name string) (int64, error) {
	var v int64
	err := s.db.QueryRowContext(ctx, "PRAGMA "+name).Scan(&v)
	return v, err
}

// HasTable reports whether a table exists, failing tb if the query fails.
func HasTable(tb testing.TB, s *Store, name string) bool {
	tb.Helper()
	var n int
	if err := s.db.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, name).Scan(&n); err != nil {
		tb.Fatalf("look up table %s: %v", name, err)
	}
	return n == 1
}

// AppliedMigrations counts applied migrations, failing tb if the query fails.
func AppliedMigrations(tb testing.TB, s *Store) int {
	tb.Helper()
	var n int
	if err := s.db.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM schema_migrations`).Scan(&n); err != nil {
		tb.Fatalf("count migrations: %v", err)
	}
	return n
}

// AddMember makes userID a member of vaultID with role, as sharing will.
func AddMember(tb testing.TB, s *Store, vaultID, userID, role string) {
	tb.Helper()
	if _, err := s.db.ExecContext(context.Background(),
		`INSERT INTO vault_members (vault_id, user_id, role) VALUES (?, ?, ?)`, vaultID, userID, role); err != nil {
		tb.Fatalf("add member: %v", err)
	}
}
