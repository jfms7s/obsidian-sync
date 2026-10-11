package app_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/app"
	"github.com/jfms7s/obsidian-sync/server/internal/bus"
	"github.com/jfms7s/obsidian-sync/server/internal/config"
)

func TestOpenBlobs(t *testing.T) {
	cfg := config.Defaults()
	cfg.BlobFSDir = filepath.Join(t.TempDir(), "blobs")
	blobs, err := app.OpenBlobs(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := blobs.Ping(context.Background()); err != nil {
		t.Fatalf("ping: %v", err)
	}

	cfg.BlobBackend = "s3"
	if _, err := app.OpenBlobs(cfg); err == nil {
		t.Fatal("an unsupported backend must be an error")
	}
}

func TestOpenBus(t *testing.T) {
	cfg := config.Defaults()
	b, err := app.OpenBus(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ch, cancel := b.Subscribe("v")
	defer cancel()
	if err := b.Publish(context.Background(), bus.Notify{VaultID: "v", Seq: 1}); err != nil {
		t.Fatal(err)
	}
	if n := <-ch; n.Seq != 1 {
		t.Fatalf("notify = %+v", n)
	}

	cfg.Cluster = true
	if _, err := app.OpenBus(cfg); err == nil {
		t.Fatal("cluster mode has no bus yet and must be an error")
	}
}
