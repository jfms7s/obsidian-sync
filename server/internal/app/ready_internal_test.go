package app

import (
	"context"
	"errors"
	"testing"
)

type pingFunc func(context.Context) error

func (f pingFunc) Ping(ctx context.Context) error { return f(ctx) }

// Readiness checks every backend that can be checked and skips one that
// cannot (the in-memory bus has no Ping).
func TestReadinessChecksEveryBackendWithPing(t *testing.T) {
	ok := pingFunc(func(context.Context) error { return nil })
	down := pingFunc(func(context.Context) error { return errors.New("bus down") })
	noPing := struct{}{}

	if err := readiness(ok, noPing, ok)(context.Background()); err != nil {
		t.Fatalf("all up: %v", err)
	}
	if err := readiness(ok, ok, down)(context.Background()); err == nil || err.Error() != "bus down" {
		t.Fatalf("one down: err = %v", err)
	}
}
