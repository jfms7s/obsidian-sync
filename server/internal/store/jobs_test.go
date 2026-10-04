package store_test

import (
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
)

const day = 24 * time.Hour

func TestPruneHistoryByAgeKeepsHeads(t *testing.T) {
	f := newFixture(t)
	v1 := storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil, storetest.ChunkID(1)))
	lone := storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(2), nil))
	f.clk.Advance(31 * day)
	storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), v1.VersionID, storetest.ChunkID(2)))

	stats, err := f.st.Prune(ctx, store.PrunePolicy{HistoryCutoffMs: f.clk.Now().Add(-30 * day).UnixMilli()})
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

func TestPurgeTrash(t *testing.T) {
	f := newFixture(t)
	v1 := storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil, storetest.ChunkID(1)))
	tomb := storetest.NewVersion(f.vault.ID, storetest.FileID(1), v1.VersionID)
	tomb.Deleted = true
	storetest.MustCommit(t, f.st, tomb)

	f.clk.Advance(10 * day)
	stats, _ := f.st.Prune(ctx, store.PrunePolicy{TrashCutoffMs: f.clk.Now().Add(-30 * day).UnixMilli()})
	if stats.FilesPurged != 0 {
		t.Fatal("purged before the trash period ended")
	}

	f.clk.Advance(21 * day)
	stats, err := f.st.Prune(ctx, store.PrunePolicy{TrashCutoffMs: f.clk.Now().Add(-30 * day).UnixMilli()})
	if err != nil || stats.FilesPurged != 1 {
		t.Fatalf("stats = %+v, err %v", stats, err)
	}
	if heads, _ := f.st.Heads(ctx, f.vault.ID, nil, 10); len(heads) != 0 {
		t.Fatalf("heads = %+v", heads)
	}
	if hist, _ := f.st.History(ctx, f.vault.ID, storetest.FileID(1)); len(hist) != 0 {
		t.Fatalf("history = %+v", hist)
	}
	// The path can be created again from scratch.
	storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil))
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
