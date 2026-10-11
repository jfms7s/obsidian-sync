// Package store owns every SQL statement obsync runs against its metadata
// database, a local SQLite file (modernc.org/sqlite, pure Go).
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

type Store struct {
	db  *sql.DB
	now func() time.Time
}

type Options struct {
	URL string // file:/path/meta.db; remote URLs are not supported yet
	// AuthToken is for a remote database. Remote databases are not
	// supported yet, so it is unused.
	AuthToken string
	// Synchronous is SQLite's synchronous mode; empty means SynchronousFull.
	Synchronous Synchronous
	Now         func() time.Time
}

// Synchronous is how hard a local database pushes each committed
// transaction to disk.
type Synchronous string

const (
	// SynchronousFull fsyncs the WAL on every commit: a committed
	// transaction survives a power loss or kernel crash.
	SynchronousFull Synchronous = "full"
	// SynchronousNormal fsyncs only at checkpoints. The database cannot be
	// corrupted, but a power loss or kernel crash can lose the last
	// committed transactions, which devices then see as a server restored
	// from a backup. A crash of obsync alone loses nothing.
	SynchronousNormal Synchronous = "normal"
)

// pragma is the PRAGMA synchronous value: what to set and what reading it
// back returns.
func (m Synchronous) pragma() (name string, value int64, err error) {
	switch m {
	case "", SynchronousFull:
		return "FULL", 2, nil
	case SynchronousNormal:
		return "NORMAL", 1, nil
	default:
		return "", 0, fmt.Errorf("synchronous mode %q is not full or normal", m)
	}
}

// ErrRemoteNotSupported is returned by Open for a libsql://, http:// or
// https:// URL. The configuration keeps those URLs for clustered mode, which
// will bring a remote client back.
var ErrRemoteNotSupported = errors.New("remote databases (libsql://, http://, https://) are not supported yet; use a local file: database")

func Open(ctx context.Context, opts Options) (*Store, error) {
	if !strings.HasPrefix(opts.URL, "file:") {
		// The URL may carry credentials: never echo it.
		return nil, ErrRemoteNotSupported
	}
	db, err := sql.Open(driverName, opts.URL)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	// A local SQLite file has a single writer. One pooled connection
	// serialises all access instead of failing with SQLITE_BUSY, so code
	// must never use s.db while it holds a transaction or open rows.
	// Keep that one connection for the life of the pool so the pragmas
	// below, which are per connection, stay in effect.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)
	db.SetConnMaxIdleTime(0)
	// Set busy_timeout before anything else touches the file: another
	// process (obsync admin, obsync migrate) may write it while the
	// server runs, and a store closed a moment ago in this process may
	// still hold it (see Close). Wait for either instead of failing.
	var timeout int
	if err := db.QueryRowContext(ctx, "PRAGMA busy_timeout=5000").Scan(&timeout); err != nil {
		db.Close()
		return nil, fmt.Errorf("set busy_timeout: %w", err)
	}
	var mode string
	if err := db.QueryRowContext(ctx, "PRAGMA journal_mode=WAL").Scan(&mode); err != nil {
		db.Close()
		return nil, fmt.Errorf("enable WAL: %w", err)
	}
	if !strings.EqualFold(mode, "wal") {
		db.Close()
		return nil, fmt.Errorf("enable WAL: journal mode is %q", mode)
	}
	if err := setSynchronous(ctx, db, opts.Synchronous); err != nil {
		db.Close()
		return nil, err
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

// setSynchronous sets the synchronous mode and reads it back, so a mode the
// driver silently ignored fails Open instead of weakening durability unseen.
func setSynchronous(ctx context.Context, db *sql.DB, m Synchronous) error {
	name, want, err := m.pragma()
	if err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx, "PRAGMA synchronous="+name); err != nil {
		return fmt.Errorf("set synchronous: %w", err)
	}
	var got int64
	if err := db.QueryRowContext(ctx, "PRAGMA synchronous").Scan(&got); err != nil {
		return fmt.Errorf("read synchronous: %w", err)
	}
	if got != want {
		return fmt.Errorf("set synchronous: mode is %d, want %d (%s)", got, want, name)
	}
	return nil
}

// Close closes the pool. Another process, or another Store on the same file,
// may still hold the file's lock (SQLite's close-time WAL checkpoint); Open
// sets busy_timeout first, so a reopen waits for it instead of failing with
// "database is locked".
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
