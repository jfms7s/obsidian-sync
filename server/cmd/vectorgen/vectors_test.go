package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// The checked-in vectors must be exactly what this generator produces, so
// a change to either side cannot drift silently. Fix with `make vectors`.
func TestVectorsUpToDate(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "plugin", "test", "vectors")
	for name, want := range render() {
		got, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Errorf("%s: %v (run make vectors)", name, err)
			continue
		}
		if !bytes.Equal(got, want) {
			t.Errorf("%s is stale; run make vectors", name)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	gen := render()
	for _, e := range entries {
		if _, ok := gen[e.Name()]; !ok {
			t.Errorf("%s is not produced by vectorgen; delete it", e.Name())
		}
	}
}

func TestRenderIsDeterministic(t *testing.T) {
	a, b := render(), render()
	for name := range a {
		if !bytes.Equal(a[name], b[name]) {
			t.Errorf("%s differs between two runs", name)
		}
	}
}
