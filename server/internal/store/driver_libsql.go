//go:build libsql

package store

import (
	// Registers the "libsql" database/sql driver (CGO, a bundled C SQLite).
	_ "github.com/tursodatabase/go-libsql"
)

// Built with -tags libsql: the go-libsql driver, which also reaches remote
// libSQL databases (sqld, Turso; remote.go).
const driverName = "libsql"

// bundledSQLiteVersion is the SQLite that go-libsql ships as a prebuilt C
// library. govulncheck cannot see it, so a test names it: bumping go-libsql
// changes it; check https://www.sqlite.org/cves.html for the new version
// before updating the constant.
const bundledSQLiteVersion = "3.45.1"

// localDSN is the data source name for a file: URL; go-libsql takes it as is.
func localDSN(url string) string { return url }
