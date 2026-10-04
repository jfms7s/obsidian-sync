package store

import "database/sql"

// DBStats exposes the pool statistics to the external tests.
func DBStats(s *Store) sql.DBStats { return s.db.Stats() }
