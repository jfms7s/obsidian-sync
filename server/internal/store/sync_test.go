package store_test

import (
	"bytes"
	"sync"
	"testing"

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

	if v, _ := f.st.VaultForMember(ctx, f.vault.ID, f.vault.OwnerID); v.Seq != 0 {
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
