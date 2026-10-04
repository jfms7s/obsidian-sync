package store

import (
	"bytes"
	"context"
	"path/filepath"
	"testing"
)

// Only a duplicate (vault_id, chunk_id) counts as "already recorded"; any
// other constraint failure must surface. INSERT OR IGNORE would swallow it
// and report a duplicate, and the caller would then delete the new blob.
func TestInsertChunkSurfacesOtherConstraintFailures(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, Options{URL: "file:" + filepath.Join(t.TempDir(), "meta.db")})
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if err := st.CreateUser(ctx, User{ID: "u", Username: "alice", PasswordHash: "x", QuotaBytes: 1 << 20}); err != nil {
		t.Fatal(err)
	}
	if err := st.CreateVault(ctx, Vault{ID: "v", OwnerID: "u", EncName: []byte("n")}, nil); err != nil {
		t.Fatal(err)
	}
	// A constraint the schema does not have, standing in for any other one.
	if _, err := st.db.ExecContext(ctx, `CREATE UNIQUE INDEX chunks_blob_key_test ON chunks (blob_key)`); err != nil {
		t.Fatal(err)
	}
	if _, err := st.InsertChunk(ctx, Chunk{VaultID: "v", ChunkID: bytes.Repeat([]byte{1}, 32), BlobKey: "same", Size: 10}); err != nil {
		t.Fatal(err)
	}
	inserted, err := st.InsertChunk(ctx, Chunk{VaultID: "v", ChunkID: bytes.Repeat([]byte{2}, 32), BlobKey: "same", Size: 10})
	if err == nil {
		t.Fatalf("inserted=%v, want the blob_key constraint failure", inserted)
	}
	if used, _ := st.UsageBytes(ctx, "u"); used != 10 {
		t.Fatalf("usage = %d, want 10", used)
	}
}
