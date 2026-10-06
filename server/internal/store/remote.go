package store

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"net/url"
	"slices"
	"strings"
	"sync"
)

// go-libsql has no public connector that takes a remote URL and a token
// separately (NewEmbeddedReplicaConnector and NewSyncedDatabaseConnector both
// need a local replica file), so the token has to reach the driver in the
// authToken query parameter. The driver strips the query before it keeps or
// formats the URL, but two paths can still carry the token into an error:
//
//   - its url.Parse error quotes the whole DSN, token included;
//   - remote (Hrana) errors embed the server's response body verbatim
//     ("api error: status=500 …, body=…"), so a proxy or server that echoes the
//     request headers puts the bearer token in every query error.
//
// The same goes for the other credentials a URL can carry: the userinfo and
// secret-named query parameters such as remoteEncryptionKey (which the driver
// sends as the X-Turso-Encryption-Key header).
//
// remoteConnector therefore wraps the driver's connector and redacts those
// secrets from every error it, its connections, statements, transactions and
// rows return. Errors without a secret pass through unchanged, so error
// matching (isUniqueViolation, sql.ErrNoRows) is unaffected.

const redacted = "REDACTED"

// libsqlDriver returns the registered go-libsql driver. Its type is
// unexported, so it is taken from a throwaway in-memory database.
var libsqlDriver = sync.OnceValues(func() (driver.Driver, error) {
	db, err := sql.Open("libsql", ":memory:")
	if err != nil {
		return nil, fmt.Errorf("load libsql driver: %w", err)
	}
	defer db.Close()
	return db.Driver(), nil
})

// openRemote returns a pool for a libsql://, http:// or https:// database. As
// with the driver itself, nothing is sent over the network until the first
// statement runs.
func openRemote(rawURL, authToken string) (*sql.DB, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		// url.Parse's error quotes the whole URL, credentials included.
		return nil, errors.New("parse database url: invalid URL")
	}
	q := u.Query()
	if authToken != "" {
		q.Set("authToken", authToken)
		u.RawQuery = q.Encode()
	}
	r := urlSecrets(u)
	drv, err := libsqlDriver()
	if err != nil {
		return nil, err
	}
	dc, ok := drv.(driver.DriverContext)
	if !ok {
		return nil, errors.New("open database: libsql driver has no connector")
	}
	c, err := dc.OpenConnector(u.String())
	if err != nil {
		return nil, fmt.Errorf("open database: %w", r.err(err))
	}
	return sql.OpenDB(&redactConnector{c: c, r: r}), nil
}

// urlSecrets collects every credential u carries, raw and escaped: the
// userinfo name and password, and the value of each query parameter whose
// key names a secret (authToken, remoteEncryptionKey, …).
func urlSecrets(u *url.URL) redactor {
	var r redactor
	add := func(s string) {
		if s == "" {
			return
		}
		for _, v := range []string{s, url.QueryEscape(s), url.PathEscape(s)} {
			if !slices.Contains(r, v) {
				r = append(r, v)
			}
		}
	}
	if u.User != nil {
		add(u.User.Username())
		if p, ok := u.User.Password(); ok {
			add(p)
		}
		// The userinfo as the URL spells it, in its own escaping.
		if raw := u.User.String(); raw != "" {
			for _, part := range strings.SplitN(raw, ":", 2) {
				add(part)
			}
		}
	}
	for k, vs := range u.Query() {
		if !isSecretParam(k) {
			continue
		}
		for _, v := range vs {
			add(v)
		}
	}
	// Longest first, so a secret that contains another is replaced whole.
	slices.SortStableFunc(r, func(a, b string) int { return len(b) - len(a) })
	return r
}

// isSecretParam reports whether a query parameter key names a credential.
func isSecretParam(key string) bool {
	k := strings.ToLower(key)
	for _, w := range []string{"key", "token", "secret", "password"} {
		if strings.Contains(k, w) {
			return true
		}
	}
	return false
}

// redactor replaces each secret in error text with REDACTED.
type redactor []string

func (r redactor) err(err error) error {
	if err == nil || len(r) == 0 {
		return err
	}
	msg := err.Error()
	clean := msg
	for _, s := range r {
		clean = strings.ReplaceAll(clean, s, redacted)
	}
	if clean == msg {
		return err
	}
	return &redactedError{msg: clean, cause: err}
}

// redactedError carries the cleaned text. It unwraps only to the context
// errors, so errors.Is(err, context.Canceled) still works while no caller can
// reach the original, token-bearing error.
type redactedError struct {
	msg   string
	cause error
}

func (e *redactedError) Error() string { return e.msg }

func (e *redactedError) Unwrap() error {
	for _, target := range []error{context.Canceled, context.DeadlineExceeded, driver.ErrBadConn} {
		if errors.Is(e.cause, target) {
			return target
		}
	}
	return nil
}

type redactConnector struct {
	c driver.Connector
	r redactor
}

func (c *redactConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.c.Connect(ctx)
	if err != nil {
		return nil, c.r.err(err)
	}
	return &redactConn{conn: conn, r: c.r}, nil
}

func (c *redactConnector) Driver() driver.Driver { return c.c.Driver() }

// Close releases the native database; sql.DB.Close calls it.
func (c *redactConnector) Close() error {
	if cl, ok := c.c.(interface{ Close() error }); ok {
		return c.r.err(cl.Close())
	}
	return nil
}

// redactConn implements the same optional interfaces as go-libsql's conn.
type redactConn struct {
	conn driver.Conn
	r    redactor
}

var (
	_ driver.ConnPrepareContext = (*redactConn)(nil)
	_ driver.ConnBeginTx        = (*redactConn)(nil)
	_ driver.ExecerContext      = (*redactConn)(nil)
	_ driver.QueryerContext     = (*redactConn)(nil)
)

func (c *redactConn) Prepare(query string) (driver.Stmt, error) {
	return c.PrepareContext(context.Background(), query)
}

func (c *redactConn) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	var (
		s   driver.Stmt
		err error
	)
	if pc, ok := c.conn.(driver.ConnPrepareContext); ok {
		s, err = pc.PrepareContext(ctx, query)
	} else {
		s, err = c.conn.Prepare(query)
	}
	if err != nil {
		return nil, c.r.err(err)
	}
	return &redactStmt{s: s, r: c.r}, nil
}

func (c *redactConn) Close() error { return c.r.err(c.conn.Close()) }

func (c *redactConn) Begin() (driver.Tx, error) {
	return c.BeginTx(context.Background(), driver.TxOptions{})
}

func (c *redactConn) BeginTx(ctx context.Context, opts driver.TxOptions) (driver.Tx, error) {
	var (
		tx  driver.Tx
		err error
	)
	if bc, ok := c.conn.(driver.ConnBeginTx); ok {
		tx, err = bc.BeginTx(ctx, opts)
	} else {
		tx, err = c.conn.Begin()
	}
	if err != nil {
		return nil, c.r.err(err)
	}
	return &redactTx{tx: tx, r: c.r}, nil
}

func (c *redactConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	ec, ok := c.conn.(driver.ExecerContext)
	if !ok {
		return nil, driver.ErrSkip
	}
	res, err := ec.ExecContext(ctx, query, args)
	return res, c.r.err(err)
}

func (c *redactConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	qc, ok := c.conn.(driver.QueryerContext)
	if !ok {
		return nil, driver.ErrSkip
	}
	rows, err := qc.QueryContext(ctx, query, args)
	if err != nil {
		return nil, c.r.err(err)
	}
	return &redactRows{rows: rows, r: c.r}, nil
}

type redactStmt struct {
	s driver.Stmt
	r redactor
}

func (s *redactStmt) Close() error  { return s.r.err(s.s.Close()) }
func (s *redactStmt) NumInput() int { return s.s.NumInput() }

func (s *redactStmt) Exec(args []driver.Value) (driver.Result, error) {
	res, err := s.s.Exec(args)
	return res, s.r.err(err)
}

func (s *redactStmt) Query(args []driver.Value) (driver.Rows, error) {
	rows, err := s.s.Query(args)
	if err != nil {
		return nil, s.r.err(err)
	}
	return &redactRows{rows: rows, r: s.r}, nil
}

func (s *redactStmt) ExecContext(ctx context.Context, args []driver.NamedValue) (driver.Result, error) {
	ec, ok := s.s.(driver.StmtExecContext)
	if !ok {
		return nil, errors.New("libsql statement has no ExecContext")
	}
	res, err := ec.ExecContext(ctx, args)
	return res, s.r.err(err)
}

func (s *redactStmt) QueryContext(ctx context.Context, args []driver.NamedValue) (driver.Rows, error) {
	qc, ok := s.s.(driver.StmtQueryContext)
	if !ok {
		return nil, errors.New("libsql statement has no QueryContext")
	}
	rows, err := qc.QueryContext(ctx, args)
	if err != nil {
		return nil, s.r.err(err)
	}
	return &redactRows{rows: rows, r: s.r}, nil
}

type redactTx struct {
	tx driver.Tx
	r  redactor
}

func (t *redactTx) Commit() error   { return t.r.err(t.tx.Commit()) }
func (t *redactTx) Rollback() error { return t.r.err(t.tx.Rollback()) }

type redactRows struct {
	rows driver.Rows
	r    redactor
}

func (r *redactRows) Columns() []string { return r.rows.Columns() }
func (r *redactRows) Close() error      { return r.r.err(r.rows.Close()) }

func (r *redactRows) Next(dest []driver.Value) error {
	err := r.rows.Next(dest)
	//nolint:errorlint // database/sql requires the driver to return the io.EOF sentinel itself
	if err == nil || err == io.EOF {
		return err
	}
	return r.r.err(err)
}
