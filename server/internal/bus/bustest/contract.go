// Package bustest is the behaviour every bus.Bus implementation must have.
package bustest

import (
	"context"
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/bus"
)

const wait = 2 * time.Second

func Run(t *testing.T, newBus func(t *testing.T) bus.Bus) {
	ctx := context.Background()

	t.Run("delivers to every subscriber of the vault", func(t *testing.T) {
		b := newBus(t)
		c1, cancel1 := b.Subscribe("v1")
		defer cancel1()
		c2, cancel2 := b.Subscribe("v1")
		defer cancel2()
		other, cancel3 := b.Subscribe("v2")
		defer cancel3()

		if err := b.Publish(ctx, bus.Notify{VaultID: "v1", Seq: 3}); err != nil {
			t.Fatal(err)
		}
		for _, c := range []<-chan bus.Notify{c1, c2} {
			if n := receive(t, c); n.Seq != 3 || n.VaultID != "v1" {
				t.Fatalf("got %+v", n)
			}
		}
		select {
		case n := <-other:
			t.Fatalf("other vault received %+v", n)
		case <-time.After(50 * time.Millisecond):
		}
	})

	t.Run("a lagging subscriber sees the highest seq", func(t *testing.T) {
		b := newBus(t)
		c, cancel := b.Subscribe("v1")
		defer cancel()
		for _, seq := range []int64{1, 5, 4} {
			if err := b.Publish(ctx, bus.Notify{VaultID: "v1", Seq: seq}); err != nil {
				t.Fatal(err)
			}
		}
		deadline := time.After(wait)
		for {
			select {
			case n := <-c:
				if n.Seq == 5 {
					return
				}
			case <-deadline:
				t.Fatal("never saw seq 5")
			}
		}
	})

	t.Run("cancel closes the channel and publish keeps working", func(t *testing.T) {
		b := newBus(t)
		c, cancel := b.Subscribe("v1")
		cancel()
		select {
		case _, ok := <-c:
			if ok {
				t.Fatal("channel delivered after cancel")
			}
		case <-time.After(wait):
			t.Fatal("channel not closed")
		}
		cancel() // idempotent
		if err := b.Publish(ctx, bus.Notify{VaultID: "v1", Seq: 1}); err != nil {
			t.Fatal(err)
		}
	})
}

func receive(t *testing.T, c <-chan bus.Notify) bus.Notify {
	t.Helper()
	select {
	case n := <-c:
		return n
	case <-time.After(wait):
		t.Fatal("no notification")
		return bus.Notify{}
	}
}
