//go:build !libsql

package store

import (
	"database/sql"
	"errors"

	// Registers the "sqlite" database/sql driver: SQLite translated to Go,
	// no CGO.
	_ "modernc.org/sqlite"
)

// The default build: modernc.org/sqlite, a pure-Go SQLite. Remote libSQL
// databases need the go-libsql build (-tags libsql).
const driverName = "sqlite"

// bundledSQLiteVersion is the SQLite that modernc.org/sqlite is translated
// from. govulncheck sees the Go module, not the SQLite release inside it, so
// a test names it: bumping modernc.org/sqlite changes it; check
// https://www.sqlite.org/cves.html for the new version before updating the
// constant.
const bundledSQLiteVersion = "3.53.4"

// localDSN is the data source name for a file: URL. modernc.org/sqlite opens
// file: URIs itself.
func localDSN(url string) string { return url }

// openRemote refuses remote databases: this build has no libSQL client.
func openRemote(string, string) (*sql.DB, error) {
	return nil, errors.New("remote databases (libsql://, http://, https://) are not supported by this build")
}
