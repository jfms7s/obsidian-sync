package store

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

// The not-head check runs once per candidate version, so it must look the
// file up by primary key instead of scanning every file in the vault.
func TestNotHeadUsesFilePrimaryKey(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, Options{URL: "file:" + filepath.Join(t.TempDir(), "meta.db")})
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	joined := queryPlan(t, st, `SELECT 1 FROM versions WHERE `+notHead)
	if !strings.Contains(joined, "SEARCH f USING") || !strings.Contains(joined, "file_id=?") {
		t.Fatalf("not-head subquery does not use the files primary key:\n%s", joined)
	}
	// The full retention predicates scan versions once and look everything
	// else up by index.
	for _, where := range []string{
		supersededBefore + ` AND ` + notHead + ` AND ` + notRestorable,
		beyondMaxVersions + ` AND ` + notHead + ` AND ` + notRestorable,
	} {
		joined := queryPlan(t, st, `SELECT 1 FROM versions WHERE `+where)
		for _, alias := range []string{"f", "h", "n", "p"} {
			if strings.Contains(joined, "SCAN "+alias+"\n") || strings.HasSuffix(joined, "SCAN "+alias) {
				t.Errorf("%s is scanned instead of searched:\n%s", alias, joined)
			}
		}
	}
}

func queryPlan(t *testing.T, st *Store, query string, args ...any) string {
	t.Helper()
	rows, err := st.db.QueryContext(context.Background(), `EXPLAIN QUERY PLAN `+query, args...)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var plan []string
	for rows.Next() {
		var id, parent, unused int
		var detail string
		if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
			t.Fatal(err)
		}
		plan = append(plan, detail)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(plan, "\n")
	t.Logf("plan:\n%s", joined)
	return joined
}
