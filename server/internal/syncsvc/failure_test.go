package syncsvc_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/blob"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
	"github.com/jfms7s/obsidian-sync/server/internal/syncsvc"
)

func TestPutChunkQuotaHoldsUnderConcurrentUploads(t *testing.T) {
	f := newFixture(t)
	small := store.User{ID: ids.New(), Username: "small", PasswordHash: "x", QuotaBytes: 5}
	if err := f.st.CreateUser(ctx, small); err != nil {
		t.Fatal(err)
	}
	v := storetest.SeedVault(t, f.st, small.ID)

	const n = 8
	errs := make([]error, n)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			errs[i] = f.svc.PutChunk(ctx, small.ID, v.ID, storetest.ChunkID(byte(i+1)), bytes.NewReader([]byte("12345")), 5)
		}()
	}
	close(start)
	wg.Wait()

	ok := 0
	for i, err := range errs {
		switch {
		case err == nil:
			ok++
		case apperr.CodeOf(err) != apperr.QuotaExceeded:
			t.Errorf("upload %d err = %v", i, err)
		}
	}
	if ok != 1 {
		t.Fatalf("%d uploads succeeded, want 1", ok)
	}
	if used, _ := f.st.UsageBytes(ctx, small.ID); used != 5 {
		t.Fatalf("usage = %d, want 5", used)
	}
	if c := f.blobCount(t); c != 1 {
		t.Fatalf("%d blobs on disk, want 1", c)
	}
}

// failingReader yields data and then err.
type failingReader struct {
	data []byte
	err  error
}

func (r *failingReader) Read(p []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, r.err
	}
	n := copy(p, r.data)
	r.data = r.data[n:]
	return n, nil
}

func TestPutChunkBodyReadFailureIsInvalid(t *testing.T) {
	f := newFixture(t)
	body := &failingReader{data: []byte("hel"), err: io.ErrUnexpectedEOF}
	err := f.svc.PutChunk(ctx, f.user.ID, f.vault.ID, storetest.ChunkID(1), body, 5)
	if apperr.CodeOf(err) != apperr.Invalid {
		t.Fatalf("err = %v, want INVALID", err)
	}
	if used, _ := f.st.UsageBytes(ctx, f.user.ID); used != 0 {
		t.Fatalf("usage = %d", used)
	}
	if n := f.blobCount(t); n != 0 {
		t.Fatalf("%d blobs left on disk", n)
	}
}

// flakyBlobs wraps a blob.Store. Its Put fails with putErr when set, and its
// Delete refuses a cancelled context like a network-backed store would.
type flakyBlobs struct {
	blob.Store
	putErr error
}

func (b *flakyBlobs) Put(ctx context.Context, key string, r io.Reader) error {
	if b.putErr != nil {
		return b.putErr
	}
	return b.Store.Put(ctx, key, r)
}

func (b *flakyBlobs) Delete(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return b.Store.Delete(ctx, key)
}

func newFlakyService(t *testing.T, f *fixture, st syncsvc.Store) (*syncsvc.Service, *flakyBlobs) {
	t.Helper()
	fs, err := blob.NewFS(f.blobDir)
	if err != nil {
		t.Fatal(err)
	}
	blobs := &flakyBlobs{Store: fs}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	return syncsvc.New(st, blobs, f.bus, syncsvc.Limits{MaxFileSizeBytes: 64 << 20}, log), blobs
}

func TestPutChunkBlobStoreFailureIsInternal(t *testing.T) {
	f := newFixture(t)
	svc, blobs := newFlakyService(t, f, f.st)
	blobs.putErr = errors.New("disk full")
	err := svc.PutChunk(ctx, f.user.ID, f.vault.ID, storetest.ChunkID(1), bytes.NewReader([]byte("hello")), 5)
	if err == nil || apperr.CodeOf(err) != apperr.Internal {
		t.Fatalf("err = %v, want INTERNAL", err)
	}
}

// cancelOnRead cancels the request context while the body is read, as when
// a client disconnects mid-request.
type cancelOnRead struct {
	r      io.Reader
	cancel context.CancelFunc
}

func (c *cancelOnRead) Read(p []byte) (int, error) {
	c.cancel()
	return c.r.Read(p)
}

func TestPutChunkCleansUpAfterClientDisconnect(t *testing.T) {
	f := newFixture(t)
	svc, _ := newFlakyService(t, f, f.st)
	reqCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	// The body is longer than declared, so the blob is written and must then be deleted.
	body := &cancelOnRead{r: bytes.NewReader([]byte("hello")), cancel: cancel}
	err := svc.PutChunk(reqCtx, f.user.ID, f.vault.ID, storetest.ChunkID(1), body, 2)
	if apperr.CodeOf(err) != apperr.Invalid {
		t.Fatalf("err = %v", err)
	}
	if n := f.blobCount(t); n != 0 {
		t.Fatalf("%d blobs left on disk after the client went away", n)
	}
}

// failingCommits fails Commit from call number failAt on (1-based) with err.
type failingCommits struct {
	*store.Store
	mu     sync.Mutex
	calls  int
	failAt int
	err    error
}

func (s *failingCommits) Commit(ctx context.Context, v store.Version) (store.CommitOutcome, error) {
	s.mu.Lock()
	s.calls++
	fail := s.calls >= s.failAt
	s.mu.Unlock()
	if fail {
		return store.CommitOutcome{}, s.err
	}
	return s.Store.Commit(ctx, v)
}

func TestCommitNotifiesAcceptedCommitsBeforeAStoreError(t *testing.T) {
	f := newFixture(t)
	svc, _ := newFlakyService(t, f, &failingCommits{Store: f.st, failAt: 3, err: errors.New("connection lost")})
	ch, cancel := f.bus.Subscribe(f.vault.ID)
	defer cancel()
	_, _, err := svc.Commit(ctx, f.user.ID, "d", f.vault.ID, []store.Version{version(1, nil), version(2, nil), version(3, nil)})
	if err == nil {
		t.Fatal("want the store error")
	}
	select {
	case n := <-ch:
		if n.Seq != 2 {
			t.Fatalf("notify seq = %d, want 2", n.Seq)
		}
	case <-time.After(time.Second):
		t.Fatal("accepted commits were not announced")
	}
}

func TestCommitToVaultDeletedConcurrentlyIsNotFound(t *testing.T) {
	f := newFixture(t)
	svc, _ := newFlakyService(t, f, &failingCommits{Store: f.st, failAt: 1, err: store.ErrNotFound})
	_, _, err := svc.Commit(ctx, f.user.ID, "d", f.vault.ID, []store.Version{version(1, nil)})
	if apperr.CodeOf(err) != apperr.NotFound {
		t.Fatalf("err = %v, want NOT_FOUND", err)
	}
}
