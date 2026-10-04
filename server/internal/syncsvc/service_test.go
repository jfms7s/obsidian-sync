package syncsvc_test

import (
	"bytes"
	"context"
	"io"
	"io/fs"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/blob"
	"github.com/jfms7s/obsidian-sync/server/internal/bus"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
	"github.com/jfms7s/obsidian-sync/server/internal/syncsvc"
)

var ctx = context.Background()

type fixture struct {
	svc     *syncsvc.Service
	st      *store.Store
	bus     *bus.Memory
	blobDir string
	user    store.User
	vault   store.Vault
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	st, _ := storetest.New(t)
	dir := t.TempDir()
	blobs, err := blob.NewFS(dir)
	if err != nil {
		t.Fatal(err)
	}
	b := bus.NewMemory()
	user := storetest.SeedUser(t, st, "alice")
	vault := storetest.SeedVault(t, st, user.ID)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := syncsvc.New(st, blobs, b, syncsvc.Limits{MaxFileSizeBytes: 64 << 20}, log)
	return &fixture{svc: svc, st: st, bus: b, blobDir: dir, user: user, vault: vault}
}

func (f *fixture) put(t *testing.T, id []byte, data string) {
	t.Helper()
	if err := f.svc.PutChunk(ctx, f.user.ID, f.vault.ID, id, bytes.NewReader([]byte(data)), int64(len(data))); err != nil {
		t.Fatalf("put chunk: %v", err)
	}
}

func (f *fixture) blobCount(t *testing.T) int {
	t.Helper()
	n := 0
	_ = filepath.WalkDir(f.blobDir, func(_ string, d fs.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() {
			n++
		}
		return nil
	})
	return n
}

func version(file byte, base []byte, chunks ...[]byte) store.Version {
	return store.Version{FileID: storetest.FileID(file), VersionID: ids.Bytes(16), BaseVersionID: base, Epoch: 1,
		EncMeta: []byte("meta"), ChunkIDs: chunks, Size: int64(len(chunks))}
}

func TestPutAndOpenChunk(t *testing.T) {
	f := newFixture(t)
	f.put(t, storetest.ChunkID(1), "hello")
	exists, err := f.svc.ChunksExist(ctx, f.user.ID, f.vault.ID, [][]byte{storetest.ChunkID(1), storetest.ChunkID(2)})
	if err != nil || !exists[0] || exists[1] {
		t.Fatalf("exists = %v, err %v", exists, err)
	}
	rc, err := f.svc.OpenChunk(ctx, f.user.ID, f.vault.ID, storetest.ChunkID(1))
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(rc)
	rc.Close()
	if string(data) != "hello" {
		t.Fatalf("data = %q", data)
	}
	if _, err := f.svc.OpenChunk(ctx, f.user.ID, f.vault.ID, storetest.ChunkID(2)); apperr.CodeOf(err) != apperr.NotFound {
		t.Fatalf("missing chunk err = %v", err)
	}
}

func TestPutChunkTwiceStoresOnce(t *testing.T) {
	f := newFixture(t)
	f.put(t, storetest.ChunkID(1), "hello")
	f.put(t, storetest.ChunkID(1), "hello")
	if used, _ := f.st.UsageBytes(ctx, f.user.ID); used != 5 {
		t.Fatalf("usage = %d", used)
	}
	if n := f.blobCount(t); n != 1 {
		t.Fatalf("%d blobs on disk, want 1", n)
	}
}

func TestPutChunkRejectsSizeMismatch(t *testing.T) {
	f := newFixture(t)
	for _, size := range []int64{10, 2} { // body shorter, then longer, than declared
		err := f.svc.PutChunk(ctx, f.user.ID, f.vault.ID, storetest.ChunkID(1), bytes.NewReader([]byte("hello")), size)
		if apperr.CodeOf(err) != apperr.Invalid {
			t.Fatalf("size %d: err = %v", size, err)
		}
	}
	if exists, _ := f.svc.ChunksExist(ctx, f.user.ID, f.vault.ID, [][]byte{storetest.ChunkID(1)}); exists[0] {
		t.Fatal("truncated chunk was recorded")
	}
	if used, _ := f.st.UsageBytes(ctx, f.user.ID); used != 0 {
		t.Fatalf("usage = %d", used)
	}
	if n := f.blobCount(t); n != 0 {
		t.Fatalf("%d blobs left on disk", n)
	}
}

func TestPutChunkLimits(t *testing.T) {
	f := newFixture(t)
	err := f.svc.PutChunk(ctx, f.user.ID, f.vault.ID, storetest.ChunkID(1), bytes.NewReader(nil), syncsvc.MaxChunkCipherBytes+1)
	if apperr.CodeOf(err) != apperr.TooLarge {
		t.Fatalf("oversized err = %v", err)
	}
	err = f.svc.PutChunk(ctx, f.user.ID, f.vault.ID, []byte("short"), bytes.NewReader([]byte("x")), 1)
	if apperr.CodeOf(err) != apperr.Invalid {
		t.Fatalf("bad id err = %v", err)
	}
}

func TestPutChunkEnforcesQuota(t *testing.T) {
	f := newFixture(t)
	small := store.User{ID: ids.New(), Username: "small", PasswordHash: "x", QuotaBytes: 8}
	if err := f.st.CreateUser(ctx, small); err != nil {
		t.Fatal(err)
	}
	v := storetest.SeedVault(t, f.st, small.ID)
	if err := f.svc.PutChunk(ctx, small.ID, v.ID, storetest.ChunkID(1), bytes.NewReader([]byte("12345")), 5); err != nil {
		t.Fatal(err)
	}
	err := f.svc.PutChunk(ctx, small.ID, v.ID, storetest.ChunkID(2), bytes.NewReader([]byte("12345")), 5)
	if apperr.CodeOf(err) != apperr.QuotaExceeded {
		t.Fatalf("err = %v", err)
	}
}

func TestNonMembersGetNotFound(t *testing.T) {
	f := newFixture(t)
	bob := storetest.SeedUser(t, f.st, "bob")
	if _, err := f.svc.ChunksExist(ctx, bob.ID, f.vault.ID, [][]byte{storetest.ChunkID(1)}); apperr.CodeOf(err) != apperr.NotFound {
		t.Fatalf("exists err = %v", err)
	}
	if _, _, err := f.svc.Commit(ctx, bob.ID, "dev", f.vault.ID, []store.Version{version(1, nil)}); apperr.CodeOf(err) != apperr.NotFound {
		t.Fatalf("commit err = %v", err)
	}
	if _, err := f.svc.Changes(ctx, f.user.ID, "not-a-vault-id", 0, 0); apperr.CodeOf(err) != apperr.NotFound {
		t.Fatalf("malformed vault id err = %v", err)
	}
}

func TestCommitPublishesNotify(t *testing.T) {
	f := newFixture(t)
	ch, cancel := f.bus.Subscribe(f.vault.ID)
	defer cancel()
	f.put(t, storetest.ChunkID(1), "hello")
	results, vaultSeq, err := f.svc.Commit(ctx, f.user.ID, "dev-1", f.vault.ID, []store.Version{version(1, nil, storetest.ChunkID(1))})
	if err != nil || len(results) != 1 || results[0].Err != nil || results[0].Seq != 1 || vaultSeq != 1 {
		t.Fatalf("results = %+v, vaultSeq %d, err %v", results, vaultSeq, err)
	}
	select {
	case n := <-ch:
		if n.Seq != 1 {
			t.Fatalf("notify seq = %d", n.Seq)
		}
	case <-time.After(time.Second):
		t.Fatal("no notification")
	}
	changes, _ := f.svc.Changes(ctx, f.user.ID, f.vault.ID, 0, 0)
	if changes.Versions[0].DeviceID != "dev-1" {
		t.Fatalf("device id = %q", changes.Versions[0].DeviceID)
	}
}

func TestCommitReportsEachCommitsOutcome(t *testing.T) {
	f := newFixture(t)
	f.put(t, storetest.ChunkID(1), "a")
	if _, _, err := f.svc.Commit(ctx, f.user.ID, "d", f.vault.ID, []store.Version{version(1, nil, storetest.ChunkID(1))}); err != nil {
		t.Fatal(err)
	}

	badID := version(2, nil)
	badID.FileID = []byte("short")
	stale := version(3, nil)
	stale.Epoch = 2
	tooBig := version(4, nil)
	tooBig.Size = 65 << 20

	results, _, err := f.svc.Commit(ctx, f.user.ID, "d", f.vault.ID, []store.Version{
		version(5, nil),                       // ok
		badID,                                 // invalid
		version(6, nil, storetest.ChunkID(9)), // missing chunk
		stale,                                 // stale epoch
		version(1, nil),                       // conflict: file 1 exists
		tooBig,                                // too large
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"", "ERROR_CODE_INVALID", "ERROR_CODE_MISSING_CHUNK", "ERROR_CODE_STALE_EPOCH", "ERROR_CODE_CONFLICT", "ERROR_CODE_TOO_LARGE"}
	for i, r := range results {
		got := ""
		if r.Err != nil {
			got = r.Err.Code.String()
		}
		if got != want[i] {
			t.Errorf("result %d = %q, want %q", i, got, want[i])
		}
	}
	if len(results[4].HeadVersionID) != 16 {
		t.Errorf("conflict carries no head: %x", results[4].HeadVersionID)
	}
}

func TestCommitBatchSize(t *testing.T) {
	f := newFixture(t)
	if _, _, err := f.svc.Commit(ctx, f.user.ID, "d", f.vault.ID, nil); apperr.CodeOf(err) != apperr.Invalid {
		t.Fatalf("empty batch err = %v", err)
	}
	batch := make([]store.Version, syncsvc.MaxCommitsPerRequest+1)
	if _, _, err := f.svc.Commit(ctx, f.user.ID, "d", f.vault.ID, batch); apperr.CodeOf(err) != apperr.Invalid {
		t.Fatalf("oversized batch err = %v", err)
	}
}

func TestChangesPaging(t *testing.T) {
	f := newFixture(t)
	for b := byte(1); b <= 3; b++ {
		if _, _, err := f.svc.Commit(ctx, f.user.ID, "d", f.vault.ID, []store.Version{version(b, nil)}); err != nil {
			t.Fatal(err)
		}
	}
	page, err := f.svc.Changes(ctx, f.user.ID, f.vault.ID, 0, 2)
	if err != nil || len(page.Versions) != 2 || !page.More || page.VaultSeq != 3 {
		t.Fatalf("page 1 = %+v, err %v", page, err)
	}
	page, _ = f.svc.Changes(ctx, f.user.ID, f.vault.ID, 2, 2)
	if len(page.Versions) != 1 || page.More {
		t.Fatalf("page 2 = %+v", page)
	}
	page, _ = f.svc.Changes(ctx, f.user.ID, f.vault.ID, 3, 2)
	if len(page.Versions) != 0 || page.More || page.VaultSeq != 3 {
		t.Fatalf("caught-up page = %+v", page)
	}
	if _, err := f.svc.Changes(ctx, f.user.ID, f.vault.ID, -1, 0); apperr.CodeOf(err) != apperr.Invalid {
		t.Fatalf("negative since err = %v", err)
	}
}
