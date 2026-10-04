package store

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"strconv"
	"strings"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Migrate applies every migration in migrations/ that has not run yet, each in
// its own transaction, in file-name order.
func (s *Store) Migrate(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx,
		`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}
	entries, err := fs.ReadDir(migrationFS, "migrations")
	if err != nil {
		return fmt.Errorf("list migrations: %w", err)
	}
	for _, e := range entries {
		version, err := strconv.Atoi(strings.SplitN(e.Name(), "_", 2)[0])
		if err != nil {
			return fmt.Errorf("migration %s: name must start with a number", e.Name())
		}
		var applied int
		if err := s.db.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM schema_migrations WHERE version = ?`, version).Scan(&applied); err != nil {
			return fmt.Errorf("check migration %d: %w", version, err)
		}
		if applied > 0 {
			continue
		}
		src, err := migrationFS.ReadFile("migrations/" + e.Name())
		if err != nil {
			return fmt.Errorf("read migration %s: %w", e.Name(), err)
		}
		err = s.withTx(ctx, func(tx *sql.Tx) error {
			for _, stmt := range splitStatements(string(src)) {
				if _, err := tx.ExecContext(ctx, stmt); err != nil {
					return fmt.Errorf("migration %s: %w", e.Name(), err)
				}
			}
			_, err := tx.ExecContext(ctx,
				`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`, version, s.nowMs())
			return err
		})
		if err != nil {
			return err
		}
	}
	return nil
}

// splitStatements splits a migration into single statements, because
// go-libsql's Exec runs only the first statement of a multi-statement string
// and silently ignores the rest. A statement ends at a line ending in ';'.
// Blank lines and lines starting with "--" are dropped.
func splitStatements(src string) []string {
	var stmts []string
	var cur strings.Builder
	for _, line := range strings.Split(src, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "--") {
			continue
		}
		cur.WriteString(line)
		cur.WriteString("\n")
		if strings.HasSuffix(trimmed, ";") {
			stmts = append(stmts, strings.TrimSpace(cur.String()))
			cur.Reset()
		}
	}
	if rest := strings.TrimSpace(cur.String()); rest != "" {
		stmts = append(stmts, rest)
	}
	return stmts
}

// HasTableForTest reports whether a table exists. Test-only inspection.
func (s *Store) HasTableForTest(ctx context.Context, name string) bool {
	var n int
	_ = s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, name).Scan(&n)
	return n == 1
}

// AppliedMigrationsForTest counts applied migrations. Test-only inspection.
func (s *Store) AppliedMigrationsForTest(ctx context.Context) int {
	var n int
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM schema_migrations`).Scan(&n)
	return n
}
