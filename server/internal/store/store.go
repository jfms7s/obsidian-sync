// Package store owns every SQL statement obsync runs against libSQL: a local
// file by default, or sqld / Turso Cloud over a direct primary connection.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	_ "github.com/tursodatabase/go-libsql"
)

type Store struct {
	db  *sql.DB
	now func() time.Time
}

type Options struct {
	URL       string // file:/path/meta.db, libsql://…, http(s)://…
	AuthToken string // remote databases only
	Now       func() time.Time
}

func Open(ctx context.Context, opts Options) (*Store, error) {
	dsn := opts.URL
	local := strings.HasPrefix(opts.URL, "file:")
	if !local && opts.AuthToken != "" {
		u, err := url.Parse(opts.URL)
		if err != nil {
			// url.Parse's error quotes the whole URL, credentials included.
			return nil, errors.New("parse database url: invalid URL")
		}
		q := u.Query()
		q.Set("authToken", opts.AuthToken)
		u.RawQuery = q.Encode()
		dsn = u.String()
	}
	db, err := sql.Open("libsql", dsn)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	if local {
		// A local libSQL file has a single writer. One pooled connection
		// serialises all access instead of failing with SQLITE_BUSY, so code
		// must never use s.db while it holds a transaction or open rows.
		// Keep that one connection for the life of the pool so the pragmas
		// below, which are per connection, stay in effect.
		db.SetMaxOpenConns(1)
		db.SetMaxIdleConns(1)
		db.SetConnMaxLifetime(0)
		db.SetConnMaxIdleTime(0)
		var mode string
		if err := db.QueryRowContext(ctx, "PRAGMA journal_mode=WAL").Scan(&mode); err != nil {
			db.Close()
			return nil, fmt.Errorf("enable WAL: %w", err)
		}
		if !strings.EqualFold(mode, "wal") {
			db.Close()
			return nil, fmt.Errorf("enable WAL: journal mode is %q", mode)
		}
		// Another process (obsync admin, obsync migrate) may write the same
		// file while the server runs; wait for its lock instead of failing.
		var timeout int
		if err := db.QueryRowContext(ctx, "PRAGMA busy_timeout=5000").Scan(&timeout); err != nil {
			db.Close()
			return nil, fmt.Errorf("set busy_timeout: %w", err)
		}
	}
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	return &Store{db: db, now: now}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }

func (s *Store) nowMs() int64 { return s.now().UnixMilli() }

func (s *Store) withTx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit transaction: %w", err)
	}
	return nil
}
