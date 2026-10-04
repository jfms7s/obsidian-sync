package store_test

import (
	"bytes"
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
)

const day = 24 * time.Hour

// historyCutoff is the cutoff the runner passes for 30 days of history.
func historyCutoff(f fixture) int64 { return f.clk.Now().Add(-30 * day).UnixMilli() }

func deleteFile(t *testing.T, f fixture, file, base []byte) store.Version {
	t.Helper()
	tomb := storetest.NewVersion(f.vault.ID, file, base)
	tomb.Deleted = true
	return storetest.MustCommit(t, f.st, tomb)
}

func TestPruneHistoryByAgeKeepsHeads(t *testing.T) {
	f := newFixture(t)
	v1 := storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil, storetest.ChunkID(1)))
	lone := storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(2), nil))
	storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), v1.VersionID, storetest.ChunkID(2)))
	f.clk.Advance(31 * day)

	stats, err := f.st.Prune(ctx, store.PrunePolicy{HistoryCutoffMs: historyCutoff(f)})
	if err != nil || stats.VersionsDeleted != 1 {
		t.Fatalf("stats = %+v, err %v", stats, err)
	}
	if hist, _ := f.st.History(ctx, f.vault.ID, storetest.FileID(1)); len(hist) != 1 {
		t.Fatalf("file 1 history = %d versions", len(hist))
	}
	if hist, _ := f.st.History(ctx, f.vault.ID, storetest.FileID(2)); len(hist) != 1 || hist[0].Seq != lone.Seq {
		t.Fatalf("an old head was pruned: %+v", hist)
	}
}

// A version's age counts from when it was superseded, not from when it was
// written: an edit after a long quiet spell keeps the previous version for
// the whole history period.
func TestPruneHistoryAgeCountsFromSupersession(t *testing.T) {
	f := newFixture(t)
	v1 := storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil, storetest.ChunkID(1)))
	f.clk.Advance(100 * day)
	storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), v1.VersionID, storetest.ChunkID(2)))

	for _, wait := range []time.Duration{0, 29 * day} {
		f.clk.Advance(wait)
		if stats, err := f.st.Prune(ctx, store.PrunePolicy{HistoryCutoffMs: historyCutoff(f)}); err != nil || stats.VersionsDeleted != 0 {
			t.Fatalf("after %v: stats = %+v, err %v; the previous version was superseded too recently", wait, stats, err)
		}
	}
	f.clk.Advance(2 * day)
	if stats, err := f.st.Prune(ctx, store.PrunePolicy{HistoryCutoffMs: historyCutoff(f)}); err != nil || stats.VersionsDeleted != 1 {
		t.Fatalf("31 days after the edit: stats = %+v, err %v", stats, err)
	}
}

// A file that sat unchanged for 100 days and is deleted today must still be
// restorable from the trash, however old its last content version is.
func TestPruneKeepsRestorableVersionOfDeletedFile(t *testing.T) {
	f := newFixture(t)
	v1 := storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil, storetest.ChunkID(1)))
	f.clk.Advance(100 * day)
	deleteFile(t, f, storetest.FileID(1), v1.VersionID)

	// Long after the history period but with the trash period not over,
	// only trash purge may remove the restorable version.
	for _, wait := range []time.Duration{0, 60 * day} {
		f.clk.Advance(wait)
		stats, err := f.st.Prune(ctx, store.PrunePolicy{HistoryCutoffMs: historyCutoff(f), MaxVersions: 1})
		if err != nil || stats.VersionsDeleted != 0 {
			t.Fatalf("after %v: stats = %+v, err %v", wait, stats, err)
		}
		hist, _ := f.st.History(ctx, f.vault.ID, storetest.FileID(1))
		if len(hist) != 2 || !bytes.Equal(hist[1].VersionID, v1.VersionID) || len(hist[1].ChunkIDs) != 1 {
			t.Fatalf("after %v: history = %+v", wait, hist)
		}
		if trash, _ := f.st.Trash(ctx, f.vault.ID); len(trash) != 1 {
			t.Fatalf("after %v: trash = %+v", wait, trash)
		}
	}
}

// With history_max_versions = 1 the tombstone must not use up the only slot.
func TestPruneMaxVersionsIgnoresTombstoneHead(t *testing.T) {
	f := newFixture(t)
	var base []byte
	var last store.Version
	for i := 0; i < 3; i++ {
		last = storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), base))
		base = last.VersionID
	}
	deleteFile(t, f, storetest.FileID(1), base)

	stats, err := f.st.Prune(ctx, store.PrunePolicy{MaxVersions: 1})
	if err != nil || stats.VersionsDeleted != 2 {
		t.Fatalf("stats = %+v, err %v", stats, err)
	}
	hist, _ := f.st.History(ctx, f.vault.ID, storetest.FileID(1))
	if len(hist) != 2 || !hist[0].Deleted || !bytes.Equal(hist[1].VersionID, last.VersionID) {
		t.Fatalf("history = %+v, want the tombstone and the last content version", hist)
	}
}

func TestPruneMaxVersions(t *testing.T) {
	f := newFixture(t)
	var base []byte
	for i := 0; i < 4; i++ {
		v := storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), base))
		base = v.VersionID
	}
	stats, err := f.st.Prune(ctx, store.PrunePolicy{MaxVersions: 2})
	if err != nil || stats.VersionsDeleted != 2 {
		t.Fatalf("stats = %+v, err %v", stats, err)
	}
	hist, _ := f.st.History(ctx, f.vault.ID, storetest.FileID(1))
	if len(hist) != 2 || hist[0].Seq != 4 || hist[1].Seq != 3 {
		t.Fatalf("history = %+v", hist)
	}
}

func TestPruneZeroPolicyKeepsHistory(t *testing.T) {
	f := newFixture(t)
	v1 := storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil))
	storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), v1.VersionID))
	f.clk.Advance(1000 * day)
	if stats, err := f.st.Prune(ctx, store.PrunePolicy{}); err != nil || stats != (store.PruneStats{}) {
		t.Fatalf("stats = %+v, err %v", stats, err)
	}
}

func TestPurgeTrash(t *testing.T) {
	f := newFixture(t)
	v1 := storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil, storetest.ChunkID(1)))
	tomb := deleteFile(t, f, storetest.FileID(1), v1.VersionID)
	trashCutoff := func() int64 { return f.clk.Now().Add(-30 * day).UnixMilli() }

	f.clk.Advance(10 * day)
	stats, _ := f.st.Prune(ctx, store.PrunePolicy{TrashCutoffMs: trashCutoff()})
	if stats.FilesPurged != 0 {
		t.Fatal("purged before the trash period ended")
	}

	f.clk.Advance(21 * day)
	stats, err := f.st.Prune(ctx, store.PrunePolicy{TrashCutoffMs: trashCutoff()})
	if err != nil || stats.FilesPurged != 1 || stats.VersionsDeleted != 0 {
		t.Fatalf("stats = %+v, err %v", stats, err)
	}
	// The tombstone stays as the head, so a device that was offline for the
	// whole trash period still learns about the deletion.
	heads, _ := f.st.Heads(ctx, f.vault.ID, nil, 10)
	if len(heads) != 1 || !heads[0].Deleted || !bytes.Equal(heads[0].VersionID, tomb.VersionID) {
		t.Fatalf("heads = %+v", heads)
	}
	changes, _ := f.st.Changes(ctx, f.vault.ID, 0, 10)
	if len(changes) != 1 || !bytes.Equal(changes[0].VersionID, tomb.VersionID) {
		t.Fatalf("changes = %+v", changes)
	}
	hist, _ := f.st.History(ctx, f.vault.ID, storetest.FileID(1))
	if len(hist) != 1 || !hist[0].Deleted {
		t.Fatalf("history = %+v", hist)
	}
	// Nothing is left to restore, so the file leaves the trash.
	if trash, _ := f.st.Trash(ctx, f.vault.ID); len(trash) != 0 {
		t.Fatalf("trash = %+v", trash)
	}
	// Its chunk is no longer referenced.
	if dead, _ := f.st.DeadChunks(ctx, f.clk.Now().UnixMilli(), 10); len(dead) != 4 {
		t.Fatalf("dead chunks = %d, want 4", len(dead))
	}
	// A purged file is not purged again.
	f.clk.Advance(day)
	if stats, _ := f.st.Prune(ctx, store.PrunePolicy{TrashCutoffMs: trashCutoff()}); stats.FilesPurged != 0 {
		t.Fatalf("stats = %+v", stats)
	}

	// The path can be created again on top of the tombstone.
	out, _ := f.st.Commit(ctx, storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil))
	if out.Reason != store.CommitConflict || !bytes.Equal(out.HeadVersionID, tomb.VersionID) {
		t.Fatalf("create without base = %+v, want a conflict naming the tombstone", out)
	}
	storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), tomb.VersionID, storetest.ChunkID(2)))
	if heads, _ := f.st.Heads(ctx, f.vault.ID, nil, 10); len(heads) != 1 || heads[0].Deleted {
		t.Fatalf("heads after re-create = %+v", heads)
	}
}

func TestDeadChunks(t *testing.T) {
	f := newFixture(t) // seeds chunks 1-4 at the fixture's start time
	start := f.clk.Now().UnixMilli()
	storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil, storetest.ChunkID(1)))

	if dead, _ := f.st.DeadChunks(ctx, start, 10); len(dead) != 0 {
		t.Fatalf("chunks inside the grace period reported dead: %+v", dead)
	}
	dead, err := f.st.DeadChunks(ctx, start+1, 10)
	if err != nil || len(dead) != 3 {
		t.Fatalf("dead = %+v, err %v (want chunks 2-4; chunk 1 is referenced)", dead, err)
	}
	before, _ := f.st.UsageBytes(ctx, f.vault.OwnerID)
	ok, err := f.st.DeleteDeadChunk(ctx, dead[0], start+1)
	if err != nil || !ok {
		t.Fatalf("delete ok=%v err=%v", ok, err)
	}
	if after, _ := f.st.UsageBytes(ctx, f.vault.OwnerID); after != before-dead[0].Size {
		t.Fatalf("usage %d → %d", before, after)
	}
	if ok, _ := f.st.DeleteDeadChunk(ctx, dead[0], start+1); ok {
		t.Fatal("deleted twice")
	}
	// Touching a chunk (an exists-check before commit) rescues it.
	f.clk.Advance(time.Minute)
	f.st.TouchChunks(ctx, f.vault.ID, [][]byte{dead[1].ChunkID})
	if ok, _ := f.st.DeleteDeadChunk(ctx, dead[1], start+1); ok {
		t.Fatal("deleted a chunk that was just touched")
	}
}

func TestAcquireLease(t *testing.T) {
	st, clk := storetest.New(t)
	if ok, err := st.AcquireLease(ctx, "maintenance", "a", time.Minute); err != nil || !ok {
		t.Fatalf("a: ok=%v err=%v", ok, err)
	}
	if ok, _ := st.AcquireLease(ctx, "maintenance", "b", time.Minute); ok {
		t.Fatal("b took a live lease")
	}
	if ok, _ := st.AcquireLease(ctx, "maintenance", "a", time.Minute); !ok {
		t.Fatal("a could not renew")
	}
	clk.Advance(2 * time.Minute)
	if ok, _ := st.AcquireLease(ctx, "maintenance", "b", time.Minute); !ok {
		t.Fatal("b could not take an expired lease")
	}
}

func TestReleaseLease(t *testing.T) {
	st, _ := storetest.New(t)
	if ok, _ := st.AcquireLease(ctx, "maintenance", "a", time.Hour); !ok {
		t.Fatal("a could not take the lease")
	}
	if err := st.ReleaseLease(ctx, "maintenance", "b"); err != nil {
		t.Fatal(err)
	}
	if ok, _ := st.AcquireLease(ctx, "maintenance", "b", time.Hour); ok {
		t.Fatal("b released a lease it does not hold")
	}
	if err := st.ReleaseLease(ctx, "maintenance", "a"); err != nil {
		t.Fatal(err)
	}
	if ok, _ := st.AcquireLease(ctx, "maintenance", "b", time.Hour); !ok {
		t.Fatal("b could not take a released lease")
	}
}
