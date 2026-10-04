package store

import (
	"reflect"
	"testing"
)

func TestSplitStatements(t *testing.T) {
	src := "-- a comment\nCREATE TABLE a (\n    x INTEGER\n);\n\nCREATE INDEX a_x ON a (x);\n"
	got := splitStatements(src)
	want := []string{"CREATE TABLE a (\n    x INTEGER\n);", "CREATE INDEX a_x ON a (x);"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q\nwant %q", got, want)
	}
}
