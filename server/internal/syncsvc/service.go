// Package syncsvc implements the sync operations on top of the store, the
// blob store and the bus: chunk upload/download, commits, and the change log.
package syncsvc

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/blob"
	"github.com/jfms7s/obsidian-sync/server/internal/bus"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

const (
	ChunkSize            = 4 << 20
	MaxChunkCipherBytes  = ChunkSize + 64 // AES-GCM nonce + tag fit with room to spare
	MaxCommitsPerRequest = 500
	MaxEncMetaBytes      = 64 << 10
	MaxChunkExistsBatch  = 1000
	DefaultPageSize      = 500
	MaxPageSize          = 1000
	DefaultHeadsPageSize = 1000
	MaxHeadsPageSize     = 5000

	fileIDLen    = 32
	versionIDLen = 16
	chunkIDLen   = 32
)

type Store interface {
	VaultForMember(ctx context.Context, vaultID, userID string) (store.Vault, error)
	UserByID(ctx context.Context, id string) (store.User, error)
	UsageBytes(ctx context.Context, ownerID string) (int64, error)
	TouchChunks(ctx context.Context, vaultID string, chunkIDs [][]byte) ([]bool, error)
	InsertChunk(ctx context.Context, c store.Chunk) (bool, error)
	ChunkBlobKey(ctx context.Context, vaultID string, chunkID []byte) (string, error)
	Commit(ctx context.Context, v store.Version) (store.CommitOutcome, error)
	Changes(ctx context.Context, vaultID string, since int64, limit int) ([]store.Version, error)
	Heads(ctx context.Context, vaultID string, after []byte, limit int) ([]store.Head, error)
	History(ctx context.Context, vaultID string, fileID []byte) ([]store.Version, error)
	Trash(ctx context.Context, vaultID string) ([]store.Version, error)
}

type Limits struct {
	MaxFileSizeBytes int64
}

type Service struct {
	st     Store
	blobs  blob.Store
	bus    bus.Bus
	limits Limits
	log    *slog.Logger
}

func New(st Store, blobs blob.Store, b bus.Bus, limits Limits, log *slog.Logger) *Service {
	return &Service{st: st, blobs: blobs, bus: b, limits: limits, log: log}
}

var (
	errVaultNotFound = apperr.New(apperr.NotFound, "vault not found")
	errQuotaExceeded = apperr.New(apperr.QuotaExceeded, "storage quota exceeded")
)

// vault loads vaultID if userID is a member. Anything else is NotFound so a
// vault's existence never leaks to outsiders.
func (s *Service) vault(ctx context.Context, userID, vaultID string) (store.Vault, error) {
	if !ids.Valid(vaultID) {
		return store.Vault{}, errVaultNotFound
	}
	v, err := s.st.VaultForMember(ctx, vaultID, userID)
	if errors.Is(err, store.ErrNotFound) {
		return store.Vault{}, errVaultNotFound
	}
	if err != nil {
		return store.Vault{}, fmt.Errorf("load vault: %w", err)
	}
	return v, nil
}

func (s *Service) ChunksExist(ctx context.Context, userID, vaultID string, chunkIDs [][]byte) ([]bool, error) {
	if len(chunkIDs) == 0 || len(chunkIDs) > MaxChunkExistsBatch {
		return nil, apperr.New(apperr.Invalid, "send between 1 and %d chunk ids", MaxChunkExistsBatch)
	}
	for _, id := range chunkIDs {
		if len(id) != chunkIDLen {
			return nil, apperr.New(apperr.Invalid, "chunk ids must be %d bytes", chunkIDLen)
		}
	}
	if _, err := s.vault(ctx, userID, vaultID); err != nil {
		return nil, err
	}
	return s.st.TouchChunks(ctx, vaultID, chunkIDs)
}

// PutChunk stores one encrypted chunk of exactly size bytes read from body.
// Uploading a chunk the vault already has is a no-op.
func (s *Service) PutChunk(ctx context.Context, userID, vaultID string, chunkID []byte, body io.Reader, size int64) error {
	if len(chunkID) != chunkIDLen {
		return apperr.New(apperr.Invalid, "chunk id must be %d bytes", chunkIDLen)
	}
	if size <= 0 {
		return apperr.New(apperr.Invalid, "chunk body must not be empty")
	}
	if size > MaxChunkCipherBytes {
		return apperr.New(apperr.TooLarge, "chunk exceeds %d bytes", MaxChunkCipherBytes)
	}
	v, err := s.vault(ctx, userID, vaultID)
	if err != nil {
		return err
	}
	exists, err := s.st.TouchChunks(ctx, vaultID, [][]byte{chunkID})
	if err != nil {
		return err
	}
	if exists[0] {
		return nil
	}
	owner, err := s.st.UserByID(ctx, v.OwnerID)
	if err != nil {
		return fmt.Errorf("load vault owner: %w", err)
	}
	used, err := s.st.UsageBytes(ctx, v.OwnerID)
	if err != nil {
		return err
	}
	if used+size > owner.QuotaBytes {
		// A fast path only: InsertChunk makes the authoritative check, since
		// concurrent uploads can all pass this one.
		return errQuotaExceeded
	}

	key := blobKey(vaultID)
	counted := &bodyReader{r: io.LimitReader(body, size+1)}
	if err := s.blobs.Put(ctx, key, counted); err != nil {
		s.deleteBlob(ctx, key) // Put can fail after publishing (e.g. the dir fsync)
		if counted.err != nil {
			// The client disconnected or sent a short body.
			return apperr.New(apperr.Invalid, "reading chunk body: %v", counted.err)
		}
		return fmt.Errorf("store chunk: %w", err)
	}
	if counted.n != size {
		s.deleteBlob(ctx, key)
		return apperr.New(apperr.Invalid, "chunk body was not the declared %d bytes", size)
	}
	inserted, err := s.st.InsertChunk(ctx, store.Chunk{VaultID: vaultID, ChunkID: chunkID, BlobKey: key, Size: size})
	if err != nil {
		s.deleteBlob(ctx, key)
		switch {
		case errors.Is(err, store.ErrQuotaExceeded):
			return errQuotaExceeded
		case errors.Is(err, store.ErrNotFound):
			return errVaultNotFound // deleted while the chunk was uploading
		}
		return err
	}
	if !inserted {
		s.deleteBlob(ctx, key) // a concurrent upload of the same chunk won
	}
	return nil
}

func (s *Service) OpenChunk(ctx context.Context, userID, vaultID string, chunkID []byte) (io.ReadCloser, error) {
	if len(chunkID) != chunkIDLen {
		return nil, apperr.New(apperr.Invalid, "chunk id must be %d bytes", chunkIDLen)
	}
	if _, err := s.vault(ctx, userID, vaultID); err != nil {
		return nil, err
	}
	key, err := s.st.ChunkBlobKey(ctx, vaultID, chunkID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, apperr.New(apperr.NotFound, "chunk not found")
	}
	if err != nil {
		return nil, err
	}
	rc, err := s.blobs.Get(ctx, key)
	if errors.Is(err, blob.ErrNotFound) {
		return nil, apperr.New(apperr.NotFound, "chunk not found")
	}
	return rc, err
}

type CommitResult struct {
	FileID        []byte
	Seq           int64
	Err           *apperr.Error // nil when the commit was accepted
	HeadVersionID []byte        // the current head, with a Conflict error
}

// Commit applies each commit independently and returns one result per
// commit plus the vault's seq afterwards. Accepted commits notify the vault's
// subscribers once, with the highest new seq.
func (s *Service) Commit(ctx context.Context, userID, deviceID, vaultID string, commits []store.Version) ([]CommitResult, int64, error) {
	if len(commits) == 0 || len(commits) > MaxCommitsPerRequest {
		return nil, 0, apperr.New(apperr.Invalid, "send between 1 and %d commits", MaxCommitsPerRequest)
	}
	v, err := s.vault(ctx, userID, vaultID)
	if err != nil {
		return nil, 0, err
	}
	results := make([]CommitResult, len(commits))
	var newest int64
	for i, c := range commits {
		results[i].FileID = c.FileID
		if verr := s.validateCommit(c); verr != nil {
			results[i].Err = verr
			continue
		}
		c.VaultID = vaultID
		c.DeviceID = deviceID
		out, err := s.st.Commit(ctx, c)
		if err != nil {
			// Commits earlier in the batch are stored; tell subscribers.
			s.publish(ctx, vaultID, newest)
			if errors.Is(err, store.ErrNotFound) {
				return nil, 0, errVaultNotFound // deleted concurrently
			}
			return nil, 0, fmt.Errorf("commit: %w", err)
		}
		switch out.Reason {
		case store.CommitOK:
			results[i].Seq = out.Seq
			newest = max(newest, out.Seq)
		case store.CommitConflict:
			results[i].Err = apperr.New(apperr.Conflict, "the file changed since the base version")
			results[i].HeadVersionID = out.HeadVersionID
		case store.CommitStaleEpoch:
			results[i].Err = apperr.New(apperr.StaleEpoch, "the vault key epoch has changed")
		case store.CommitMissingChunk:
			results[i].Err = apperr.New(apperr.MissingChunk, "a referenced chunk is not on the server; upload it again")
		default:
			results[i].Err = apperr.New(apperr.Invalid, "%s", out.Detail)
		}
	}
	s.publish(ctx, vaultID, newest)
	return results, max(v.Seq, newest), nil
}

// publish notifies vaultID's subscribers of seq, if any commit was accepted.
func (s *Service) publish(ctx context.Context, vaultID string, seq int64) {
	if seq == 0 {
		return
	}
	if err := s.bus.Publish(context.WithoutCancel(ctx), bus.Notify{VaultID: vaultID, Seq: seq}); err != nil {
		// Clients still converge through their next pull or reconcile.
		s.log.Error("publish notification", "vault", vaultID, "err", err)
	}
}

func (s *Service) validateCommit(c store.Version) *apperr.Error {
	maxChunks := int(s.limits.MaxFileSizeBytes/ChunkSize) + 1
	switch {
	case len(c.FileID) != fileIDLen:
		return apperr.New(apperr.Invalid, "file_id must be %d bytes", fileIDLen)
	case len(c.VersionID) != versionIDLen:
		return apperr.New(apperr.Invalid, "version_id must be %d bytes", versionIDLen)
	case len(c.BaseVersionID) != 0 && len(c.BaseVersionID) != versionIDLen:
		return apperr.New(apperr.Invalid, "base_version_id must be empty or %d bytes", versionIDLen)
	case c.Epoch < 1:
		return apperr.New(apperr.Invalid, "epoch must be at least 1")
	case len(c.EncMeta) == 0 || len(c.EncMeta) > MaxEncMetaBytes:
		return apperr.New(apperr.Invalid, "enc_meta must be 1 to %d bytes", MaxEncMetaBytes)
	case c.Size < 0:
		return apperr.New(apperr.Invalid, "size must not be negative")
	case c.Size > s.limits.MaxFileSizeBytes:
		return apperr.New(apperr.TooLarge, "file exceeds the %d byte limit", s.limits.MaxFileSizeBytes)
	case c.Deleted && (len(c.ChunkIDs) > 0 || c.Size != 0):
		return apperr.New(apperr.Invalid, "a deletion carries no chunks and no size")
	case len(c.ChunkIDs) > maxChunks:
		return apperr.New(apperr.Invalid, "a file has at most %d chunks", maxChunks)
	}
	for _, id := range c.ChunkIDs {
		if len(id) != chunkIDLen {
			return apperr.New(apperr.Invalid, "chunk ids must be %d bytes", chunkIDLen)
		}
	}
	return nil
}

type ChangesPage struct {
	Versions []store.Version
	VaultSeq int64
	More     bool
}

func (s *Service) Changes(ctx context.Context, userID, vaultID string, since int64, limit int) (ChangesPage, error) {
	if since < 0 {
		return ChangesPage{}, apperr.New(apperr.Invalid, "since must not be negative")
	}
	limit = clampLimit(limit, DefaultPageSize, MaxPageSize)
	v, err := s.vault(ctx, userID, vaultID)
	if err != nil {
		return ChangesPage{}, err
	}
	versions, err := s.st.Changes(ctx, vaultID, since, limit)
	if err != nil {
		return ChangesPage{}, err
	}
	seq := v.Seq
	if n := len(versions); n > 0 {
		seq = max(seq, versions[n-1].Seq)
	}
	return ChangesPage{Versions: versions, VaultSeq: seq, More: len(versions) == limit}, nil
}

type HeadsPage struct {
	Heads []store.Head
	More  bool
}

func (s *Service) Heads(ctx context.Context, userID, vaultID string, after []byte, limit int) (HeadsPage, error) {
	if len(after) != 0 && len(after) != fileIDLen {
		return HeadsPage{}, apperr.New(apperr.Invalid, "after must be empty or %d bytes", fileIDLen)
	}
	limit = clampLimit(limit, DefaultHeadsPageSize, MaxHeadsPageSize)
	if _, err := s.vault(ctx, userID, vaultID); err != nil {
		return HeadsPage{}, err
	}
	heads, err := s.st.Heads(ctx, vaultID, after, limit)
	if err != nil {
		return HeadsPage{}, err
	}
	return HeadsPage{Heads: heads, More: len(heads) == limit}, nil
}

func (s *Service) History(ctx context.Context, userID, vaultID string, fileID []byte) ([]store.Version, error) {
	if len(fileID) != fileIDLen {
		return nil, apperr.New(apperr.Invalid, "file id must be %d bytes", fileIDLen)
	}
	if _, err := s.vault(ctx, userID, vaultID); err != nil {
		return nil, err
	}
	return s.st.History(ctx, vaultID, fileID)
}

func (s *Service) Trash(ctx context.Context, userID, vaultID string) ([]store.Version, error) {
	if _, err := s.vault(ctx, userID, vaultID); err != nil {
		return nil, err
	}
	return s.st.Trash(ctx, vaultID)
}

// deleteBlob removes a blob no chunk row refers to. It runs even when the
// request was cancelled (e.g. the client disconnected), which is often why
// the blob needs removing.
func (s *Service) deleteBlob(ctx context.Context, key string) {
	if err := s.blobs.Delete(context.WithoutCancel(ctx), key); err != nil {
		s.log.Warn("delete orphaned blob", "blob_key", key, "err", err)
	}
}

// blobKey is unique per upload: <vault>/<2 hex>/<32 hex>.
func blobKey(vaultID string) string {
	h := hex.EncodeToString(ids.Bytes(16))
	return vaultID + "/" + h[:2] + "/" + h
}

func clampLimit(n, def, maxN int) int {
	if n <= 0 {
		return def
	}
	return min(n, maxN)
}

// bodyReader counts the bytes read from a request body and remembers a read
// failure, so PutChunk can tell a client-side failure (short body,
// disconnect) from a blob store failure whatever the blob store wraps.
type bodyReader struct {
	r   io.Reader
	n   int64
	err error // the first read error other than io.EOF
}

func (b *bodyReader) Read(p []byte) (int, error) {
	n, err := b.r.Read(p)
	b.n += int64(n)
	if err != nil && err != io.EOF && b.err == nil {
		b.err = err
	}
	return n, err
}
