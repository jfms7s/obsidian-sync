package store_test

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
)

type fixture struct {
	st    *store.Store
	clk   *storetest.Clock
	vault store.Vault
}

func newFixture(t *testing.T) fixture {
	st, clk := storetest.New(t)
	u := storetest.SeedUser(t, st, "alice")
	v := storetest.SeedVault(t, st, u.ID)
	for b := byte(1); b <= 4; b++ {
		storetest.SeedChunk(t, st, v.ID, storetest.ChunkID(b), 10)
	}
	return fixture{st: st, clk: clk, vault: v}
}

func TestCommitCreateThenUpdate(t *testing.T) {
	f := newFixture(t)
	v1 := storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil, storetest.ChunkID(1), storetest.ChunkID(2)))
	if v1.Seq != 1 {
		t.Fatalf("seq = %d", v1.Seq)
	}
	v2 := storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), v1.VersionID, storetest.ChunkID(3)))
	if v2.Seq != 2 {
		t.Fatalf("seq = %d", v2.Seq)
	}

	changes, err := f.st.Changes(ctx, f.vault.ID, 0, 10)
	if err != nil || len(changes) != 2 {
		t.Fatalf("changes = %+v, err %v", changes, err)
	}
	c := changes[0]
	if !bytes.Equal(c.VersionID, v1.VersionID) || c.Seq != 1 || len(c.ChunkIDs) != 2 ||
		!bytes.Equal(c.ChunkIDs[0], storetest.ChunkID(1)) || !bytes.Equal(c.ChunkIDs[1], storetest.ChunkID(2)) ||
		c.BaseVersionID != nil || c.DeviceID != "dev" || c.Epoch != 1 || string(c.EncMeta) != "meta" {
		t.Fatalf("first change = %+v", c)
	}
	if !bytes.Equal(changes[1].BaseVersionID, v1.VersionID) {
		t.Fatalf("second change base = %x", changes[1].BaseVersionID)
	}
}

func TestCommitConflictReturnsHead(t *testing.T) {
	f := newFixture(t)
	v1 := storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil, storetest.ChunkID(1)))

	// Someone else also thinks the file is new.
	out, err := f.st.Commit(ctx, storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil, storetest.ChunkID(2)))
	if err != nil || out.Reason != store.CommitConflict || !bytes.Equal(out.HeadVersionID, v1.VersionID) {
		t.Fatalf("out = %+v, err %v", out, err)
	}
	// A base that does not exist on the server, for a file the server lacks.
	out, _ = f.st.Commit(ctx, storetest.NewVersion(f.vault.ID, storetest.FileID(2), bytes.Repeat([]byte{7}, 16)))
	if out.Reason != store.CommitConflict || out.HeadVersionID != nil {
		t.Fatalf("out = %+v", out)
	}
}

func TestCommitRetryIsIdempotent(t *testing.T) {
	f := newFixture(t)
	v := storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil, storetest.ChunkID(1))
	first := storetest.MustCommit(t, f.st, v)
	again, err := f.st.Commit(ctx, v)
	if err != nil || !again.OK() || again.Seq != first.Seq {
		t.Fatalf("retry = %+v, err %v; want OK with seq %d", again, err, first.Seq)
	}
	if changes, _ := f.st.Changes(ctx, f.vault.ID, 0, 10); len(changes) != 1 {
		t.Fatalf("retry created a second version: %d changes", len(changes))
	}
	// The same version id on another file is a client bug, not a retry.
	other := v
	other.FileID = storetest.FileID(2)
	if out, _ := f.st.Commit(ctx, other); out.Reason != store.CommitInvalid {
		t.Fatalf("out = %+v", out)
	}

	// The same version id on the same file with different content is not a
	// retry either. A fresh enc_meta alone is (the client re-encrypted).
	reEncrypted := v
	reEncrypted.EncMeta = []byte("other nonce")
	if out, err := f.st.Commit(ctx, reEncrypted); err != nil || !out.OK() || out.Seq != first.Seq {
		t.Fatalf("re-encrypted retry = %+v, err %v", out, err)
	}
	tamper := map[string]func(*store.Version){
		"chunks":    func(c *store.Version) { c.ChunkIDs = [][]byte{storetest.ChunkID(2)} },
		"no chunks": func(c *store.Version) { c.ChunkIDs = nil },
		"order": func(c *store.Version) {
			c.ChunkIDs = [][]byte{storetest.ChunkID(1), storetest.ChunkID(1)}
		},
		"size":    func(c *store.Version) { c.Size = 99 },
		"epoch":   func(c *store.Version) { c.Epoch = 2 },
		"deleted": func(c *store.Version) { c.Deleted = true; c.ChunkIDs = nil },
		"base":    func(c *store.Version) { c.BaseVersionID = bytes.Repeat([]byte{7}, 16) },
	}
	for name, mutate := range tamper {
		c := v
		mutate(&c)
		out, err := f.st.Commit(ctx, c)
		if err != nil || out.Reason != store.CommitInvalid {
			t.Errorf("%s: out = %+v, err %v; want invalid", name, out, err)
		}
	}
}

func TestCommitRetryComparesChunkOrder(t *testing.T) {
	f := newFixture(t)
	v := storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil, storetest.ChunkID(1), storetest.ChunkID(2))
	storetest.MustCommit(t, f.st, v)
	swapped := v
	swapped.ChunkIDs = [][]byte{storetest.ChunkID(2), storetest.ChunkID(1)}
	if out, err := f.st.Commit(ctx, swapped); err != nil || out.Reason != store.CommitInvalid {
		t.Fatalf("out = %+v, err %v; want invalid", out, err)
	}
}

func TestCommitRejections(t *testing.T) {
	f := newFixture(t)

	missing := storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil, storetest.ChunkID(9))
	if out, _ := f.st.Commit(ctx, missing); out.Reason != store.CommitMissingChunk {
		t.Fatalf("missing chunk: %+v", out)
	}

	stale := storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil, storetest.ChunkID(1))
	stale.Epoch = 2
	if out, _ := f.st.Commit(ctx, stale); out.Reason != store.CommitStaleEpoch {
		t.Fatalf("stale epoch: %+v", out)
	}

	tombstone := storetest.NewVersion(f.vault.ID, storetest.FileID(3), nil)
	tombstone.Deleted = true
	if out, _ := f.st.Commit(ctx, tombstone); out.Reason != store.CommitInvalid {
		t.Fatalf("delete of unknown file: %+v", out)
	}

	live := storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(4), nil, storetest.ChunkID(1)))
	withChunks := storetest.NewVersion(f.vault.ID, storetest.FileID(4), live.VersionID, storetest.ChunkID(1))
	withChunks.Deleted = true
	if out, _ := f.st.Commit(ctx, withChunks); out.Reason != store.CommitInvalid {
		t.Fatalf("tombstone with chunks: %+v", out)
	}

	if v, _ := f.st.VaultForMember(ctx, f.vault.ID, f.vault.OwnerID); v.Seq != 1 {
		t.Fatalf("rejected commits advanced seq to %d", v.Seq)
	}
}

func TestConcurrentCreatesOfOneFileHaveOneWinner(t *testing.T) {
	f := newFixture(t)
	const n = 20
	outcomes := make([]store.CommitOutcome, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			out, err := f.st.Commit(ctx, storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil, storetest.ChunkID(1)))
			if err != nil {
				t.Error(err)
			}
			outcomes[i] = out
		}(i)
	}
	wg.Wait()
	ok := 0
	for _, o := range outcomes {
		switch o.Reason {
		case store.CommitOK:
			ok++
		case store.CommitConflict:
		default:
			t.Fatalf("unexpected outcome %+v", o)
		}
	}
	if ok != 1 {
		t.Fatalf("%d winners, want 1", ok)
	}
}

func TestConcurrentCommitsGetGaplessSeqs(t *testing.T) {
	f := newFixture(t)
	const n = 20
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if out, err := f.st.Commit(ctx, storetest.NewVersion(f.vault.ID, storetest.FileID(byte(10+i)), nil)); err != nil || !out.OK() {
				t.Errorf("out %+v err %v", out, err)
			}
		}(i)
	}
	wg.Wait()
	changes, err := f.st.Changes(ctx, f.vault.ID, 0, 100)
	if err != nil || len(changes) != n {
		t.Fatalf("changes = %d, err %v", len(changes), err)
	}
	for i, c := range changes {
		if c.Seq != int64(i+1) {
			t.Fatalf("change %d has seq %d", i, c.Seq)
		}
	}
}

func TestConcurrentCommitsFromTwoConnections(t *testing.T) {
	// Two stores on one file stand in for two processes (or two pooled
	// connections) committing at once: neither may fail with SQLITE_BUSY.
	url := "file:" + filepath.Join(t.TempDir(), "meta.db")
	clk := storetest.NewClock()
	open := func() *store.Store {
		st, err := store.Open(context.Background(), store.Options{URL: url, Now: clk.Now})
		if err != nil {
			t.Fatalf("open: %v", err)
		}
		t.Cleanup(func() { _ = st.Close() })
		return st
	}
	a, b := open(), open()
	if err := a.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	u := storetest.SeedUser(t, a, "alice")
	vault := storetest.SeedVault(t, a, u.ID)

	const n = 40
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			st := a
			if i%2 == 1 {
				st = b
			}
			if out, err := st.Commit(ctx, storetest.NewVersion(vault.ID, storetest.FileID(byte(10+i)), nil)); err != nil || !out.OK() {
				t.Errorf("commit %d: out %+v err %v", i, out, err)
			}
		}(i)
	}
	wg.Wait()
	changes, err := b.Changes(ctx, vault.ID, 0, 100)
	if err != nil || len(changes) != n {
		t.Fatalf("changes = %d, err %v", len(changes), err)
	}
	for i, c := range changes {
		if c.Seq != int64(i+1) {
			t.Fatalf("change %d has seq %d", i, c.Seq)
		}
	}
}

func TestCommitTouchesReferencedChunks(t *testing.T) {
	path := filepath.Join(t.TempDir(), "meta.db")
	clk := storetest.NewClock()
	st, err := store.Open(ctx, store.Options{URL: "file:" + path, Now: clk.Now})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	u := storetest.SeedUser(t, st, "alice")
	vault := storetest.SeedVault(t, st, u.ID)
	storetest.SeedChunk(t, st, vault.ID, storetest.ChunkID(1), 10)
	storetest.SeedChunk(t, st, vault.ID, storetest.ChunkID(2), 10)
	seeded := clk.Now().UnixMilli()
	clk.Advance(time.Hour)
	storetest.MustCommit(t, st, storetest.NewVersion(vault.ID, storetest.FileID(1), nil, storetest.ChunkID(1)))

	raw, err := sql.Open("libsql", "file:"+path)
	if err != nil {
		t.Fatalf("open raw: %v", err)
	}
	defer raw.Close()
	touchedAt := func(id []byte) int64 {
		var ms int64
		if err := raw.QueryRowContext(ctx, `SELECT touched_at FROM chunks WHERE vault_id = ? AND chunk_id = ?`, vault.ID, id).Scan(&ms); err != nil {
			t.Fatalf("read touched_at: %v", err)
		}
		return ms
	}
	if got := touchedAt(storetest.ChunkID(1)); got != clk.Now().UnixMilli() {
		t.Errorf("referenced chunk touched_at = %d, want %d", got, clk.Now().UnixMilli())
	}
	if got := touchedAt(storetest.ChunkID(2)); got != seeded {
		t.Errorf("unreferenced chunk touched_at = %d, want %d", got, seeded)
	}
}

func TestPagingRejectsNonPositiveLimit(t *testing.T) {
	f := newFixture(t)
	storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil))
	for _, limit := range []int{0, -1} {
		if got, err := f.st.Changes(ctx, f.vault.ID, 0, limit); err == nil {
			t.Errorf("Changes limit %d = %d versions, want error", limit, len(got))
		}
		if got, err := f.st.Heads(ctx, f.vault.ID, nil, limit); err == nil {
			t.Errorf("Heads limit %d = %d heads, want error", limit, len(got))
		}
	}
}

func TestChangesSince(t *testing.T) {
	f := newFixture(t)
	for b := byte(1); b <= 3; b++ {
		storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(b), nil))
	}
	page, _ := f.st.Changes(ctx, f.vault.ID, 1, 10)
	if len(page) != 2 || page[0].Seq != 2 {
		t.Fatalf("page = %+v", page)
	}
	if page, _ := f.st.Changes(ctx, f.vault.ID, 3, 10); len(page) != 0 {
		t.Fatalf("since == vault seq must be empty, got %d", len(page))
	}
	if page, _ := f.st.Changes(ctx, f.vault.ID, 0, 2); len(page) != 2 || page[1].Seq != 2 {
		t.Fatalf("limit not applied: %+v", page)
	}
}

func TestHeadsPaging(t *testing.T) {
	f := newFixture(t)
	for b := byte(1); b <= 4; b++ {
		storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(b), nil))
	}
	first, err := f.st.Heads(ctx, f.vault.ID, nil, 2)
	if err != nil || len(first) != 2 || !bytes.Equal(first[0].FileID, storetest.FileID(1)) {
		t.Fatalf("first = %+v, err %v", first, err)
	}
	second, _ := f.st.Heads(ctx, f.vault.ID, first[1].FileID, 2)
	if len(second) != 2 || !bytes.Equal(second[1].FileID, storetest.FileID(4)) {
		t.Fatalf("second = %+v", second)
	}
	if third, _ := f.st.Heads(ctx, f.vault.ID, second[1].FileID, 2); len(third) != 0 {
		t.Fatalf("third page = %+v, want empty", third)
	}
}

func TestHistoryAndTrash(t *testing.T) {
	f := newFixture(t)
	v1 := storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil, storetest.ChunkID(1)))
	v2 := storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), v1.VersionID, storetest.ChunkID(2)))
	tomb := storetest.NewVersion(f.vault.ID, storetest.FileID(1), v2.VersionID)
	tomb.Deleted = true
	tomb = storetest.MustCommit(t, f.st, tomb)
	storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(2), nil))

	hist, err := f.st.History(ctx, f.vault.ID, storetest.FileID(1))
	if err != nil || len(hist) != 3 || !hist[0].Deleted || hist[2].Seq != 1 || len(hist[1].ChunkIDs) != 1 {
		t.Fatalf("history = %+v, err %v", hist, err)
	}
	trash, err := f.st.Trash(ctx, f.vault.ID)
	if err != nil || len(trash) != 1 || !bytes.Equal(trash[0].VersionID, tomb.VersionID) {
		t.Fatalf("trash = %+v, err %v", trash, err)
	}
	heads, _ := f.st.Heads(ctx, f.vault.ID, nil, 10)
	if len(heads) != 2 || !heads[0].Deleted || heads[1].Deleted {
		t.Fatalf("heads = %+v", heads)
	}

	// Re-creating a deleted file uses the tombstone as its base.
	storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), tomb.VersionID, storetest.ChunkID(3)))
	if trash, _ := f.st.Trash(ctx, f.vault.ID); len(trash) != 0 {
		t.Fatalf("restored file still in trash: %+v", trash)
	}
}

// commitBatch is a batch that mixes every outcome: a create, an update that
// builds on it inside the batch, a conflict, a stale epoch, a missing chunk, a
// tombstone of an unknown file, a second create and a retry of the first.
func commitBatch(vaultID string) []store.Version {
	create := storetest.NewVersion(vaultID, storetest.FileID(1), nil, storetest.ChunkID(1))
	update := storetest.NewVersion(vaultID, storetest.FileID(1), create.VersionID, storetest.ChunkID(2))
	conflict := storetest.NewVersion(vaultID, storetest.FileID(1), nil, storetest.ChunkID(3))
	stale := storetest.NewVersion(vaultID, storetest.FileID(2), nil, storetest.ChunkID(1))
	stale.Epoch = 2
	missing := storetest.NewVersion(vaultID, storetest.FileID(2), nil, storetest.ChunkID(9))
	tombstone := storetest.NewVersion(vaultID, storetest.FileID(3), nil)
	tombstone.Deleted = true
	other := storetest.NewVersion(vaultID, storetest.FileID(4), nil, storetest.ChunkID(4))
	return []store.Version{create, update, conflict, stale, missing, tombstone, other, create}
}

func withVault(vs []store.Version, vaultID string) []store.Version {
	out := make([]store.Version, len(vs))
	for i, v := range vs {
		v.VaultID = vaultID
		out[i] = v
	}
	return out
}

func TestCommitAllMatchesCommittingOneByOne(t *testing.T) {
	batch := commitBatch("")

	one := newFixture(t)
	var want []store.CommitOutcome
	for _, v := range withVault(batch, one.vault.ID) {
		out, err := one.st.Commit(ctx, v)
		if err != nil {
			t.Fatalf("commit: %v", err)
		}
		want = append(want, out)
	}

	all := newFixture(t)
	got, err := all.st.CommitAll(ctx, withVault(batch, all.vault.ID))
	if err != nil {
		t.Fatalf("commit all: %v", err)
	}
	if len(got) != len(want) {
		t.Fatalf("%d outcomes, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i].Reason != want[i].Reason || got[i].Seq != want[i].Seq ||
			!bytes.Equal(got[i].HeadVersionID, want[i].HeadVersionID) || got[i].Detail != want[i].Detail {
			t.Errorf("outcome %d = %+v, want %+v", i, got[i], want[i])
		}
	}
	wantReasons := []store.CommitReason{store.CommitOK, store.CommitOK, store.CommitConflict, store.CommitStaleEpoch,
		store.CommitMissingChunk, store.CommitInvalid, store.CommitOK, store.CommitOK}
	wantSeqs := []int64{1, 2, 0, 0, 0, 0, 3, 1}
	for i := range wantReasons {
		if got[i].Reason != wantReasons[i] || got[i].Seq != wantSeqs[i] {
			t.Errorf("outcome %d = %+v, want reason %d seq %d", i, got[i], wantReasons[i], wantSeqs[i])
		}
	}
	if !bytes.Equal(got[2].HeadVersionID, batch[1].VersionID) {
		t.Errorf("conflict head = %x, want the update made earlier in the batch", got[2].HeadVersionID)
	}
	changes, err := all.st.Changes(ctx, all.vault.ID, 0, 10)
	if err != nil || len(changes) != 3 {
		t.Fatalf("changes = %d, err %v; want 3", len(changes), err)
	}
	for i, c := range changes {
		if c.Seq != int64(i+1) {
			t.Fatalf("change %d has seq %d; seqs must be gapless", i, c.Seq)
		}
	}
}

func TestCommitAllRollsBackTheWholeBatchOnAnError(t *testing.T) {
	f := newFixture(t)
	batch := []store.Version{
		storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil, storetest.ChunkID(1)),
		storetest.NewVersion(f.vault.ID, storetest.FileID(2), nil, storetest.ChunkID(2)),
		storetest.NewVersion("no-such-vault", storetest.FileID(3), nil),
	}
	if _, err := f.st.CommitAll(ctx, batch); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	if changes, _ := f.st.Changes(ctx, f.vault.ID, 0, 10); len(changes) != 0 {
		t.Fatalf("%d commits of a failed batch were stored", len(changes))
	}
	if v, _ := f.st.VaultForMember(ctx, f.vault.ID, f.vault.OwnerID); v.Seq != 0 {
		t.Fatalf("a failed batch advanced seq to %d", v.Seq)
	}
}

// benchmarkCommits commits 500 new files, either in one CommitAll or one
// Commit (one transaction) each.
func benchmarkCommits(b *testing.B, batched bool) {
	const n = 500
	for b.Loop() {
		b.StopTimer()
		st, _ := storetest.New(b)
		u := storetest.SeedUser(b, st, "alice")
		v := storetest.SeedVault(b, st, u.ID)
		vs := make([]store.Version, n)
		for i := range vs {
			vs[i] = storetest.NewVersion(v.ID, ids.Bytes(32), nil)
		}
		b.StartTimer()
		if batched {
			if _, err := st.CommitAll(ctx, vs); err != nil {
				b.Fatal(err)
			}
			continue
		}
		for _, c := range vs {
			if _, err := st.Commit(ctx, c); err != nil {
				b.Fatal(err)
			}
		}
	}
}

func BenchmarkCommitBatch500(b *testing.B)    { benchmarkCommits(b, true) }
func BenchmarkCommitOneByOne500(b *testing.B) { benchmarkCommits(b, false) }
