package store

import (
	// Registers the "sqlite" database/sql driver: SQLite translated to Go,
	// no CGO.
	_ "modernc.org/sqlite"
)

// driverName is the database/sql driver for modernc.org/sqlite.
const driverName = "sqlite"

// bundledSQLiteVersion is the SQLite that modernc.org/sqlite is translated
// from. govulncheck sees the Go module, not the SQLite release inside it, so
// a test names it: bumping modernc.org/sqlite changes it; check
// https://www.sqlite.org/cves.html for the new version before updating the
// constant.
const bundledSQLiteVersion = "3.53.4"
