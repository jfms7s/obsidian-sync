package store

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strconv"
	"strings"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// errMigrationApplied rolls back a migration that another process recorded
// first.
var errMigrationApplied = errors.New("migration already applied")

// Migrate applies every migration in migrations/ that has not run yet, each in
// its own transaction, in file-name order.
func (s *Store) Migrate(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx,
		`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}
	migrations, err := listMigrations()
	if err != nil {
		return err
	}
	for _, m := range migrations {
		version, name := m.version, m.name
		var applied int
		if err := s.db.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM schema_migrations WHERE version = ?`, version).Scan(&applied); err != nil {
			return fmt.Errorf("check migration %d: %w", version, err)
		}
		if applied > 0 {
			continue
		}
		src, err := migrationFS.ReadFile("migrations/" + name)
		if err != nil {
			return fmt.Errorf("read migration %s: %w", name, err)
		}
		stmts := splitStatements(string(src))
		for _, stmt := range stmts {
			// A ';' anywhere but the end means two statements were merged,
			// and go-libsql would silently run only the first.
			if strings.Count(stmt, ";") > 1 || (strings.Contains(stmt, ";") && !strings.HasSuffix(stmt, ";")) {
				return fmt.Errorf("migration %s: each statement must end its own line with ';': %.60q", name, stmt)
			}
		}
		err = s.withTx(ctx, func(tx *sql.Tx) error {
			// Record the version first: the write takes the write lock (see
			// commitTx), so a second process migrating concurrently waits
			// here and then finds the version taken, instead of failing on
			// the migration's own statements.
			if _, err := tx.ExecContext(ctx,
				`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`, version, s.nowMs()); err != nil {
				if isUniqueViolation(err) {
					return errMigrationApplied
				}
				return fmt.Errorf("record migration %s: %w", name, err)
			}
			for _, stmt := range stmts {
				if _, err := tx.ExecContext(ctx, stmt); err != nil {
					return fmt.Errorf("migration %s: %w", name, err)
				}
			}
			return nil
		})
		if errors.Is(err, errMigrationApplied) {
			continue // another process applied it meanwhile
		}
		if err != nil {
			return err
		}
	}
	return nil
}

type migration struct {
	version int
	name    string
}

// listMigrations returns the embedded migrations sorted by numeric version,
// rejecting names without a leading number and duplicate versions.
func listMigrations() ([]migration, error) {
	entries, err := fs.ReadDir(migrationFS, "migrations")
	if err != nil {
		return nil, fmt.Errorf("list migrations: %w", err)
	}
	var out []migration
	seen := map[int]string{}
	for _, e := range entries {
		version, err := strconv.Atoi(strings.SplitN(e.Name(), "_", 2)[0])
		if err != nil {
			return nil, fmt.Errorf("migration %s: name must start with a number", e.Name())
		}
		if prev, ok := seen[version]; ok {
			return nil, fmt.Errorf("migrations %s and %s share version %d", prev, e.Name(), version)
		}
		seen[version] = e.Name()
		out = append(out, migration{version: version, name: e.Name()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].version < out[j].version })
	return out, nil
}

// splitStatements splits a migration into single statements, because
// go-libsql's Exec runs only the first statement of a multi-statement string
// and silently ignores the rest. A statement ends at a line ending in ';'.
// Blank lines and lines starting with "--" are dropped. Migrations must
// therefore put at most one statement per line group, end it with ';' at the
// end of a line, and avoid ';' inside literals, trailing comments and triggers;
// Migrate rejects a statement that breaks this rule.
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
