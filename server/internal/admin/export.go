package admin

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/jobs"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

const (
	// exportLeaseTTL bounds how long a crashed export keeps maintenance off;
	// a running export renews the lease every exportLeaseRenew.
	exportLeaseTTL   = 10 * time.Minute
	exportLeaseRenew = 2 * time.Minute
	// exportLeasePoll is how often a waiting export asks for the lease again.
	exportLeasePoll = time.Second
	manifestName    = "MANIFEST.json"
	// ExitMissingBlobs is the exit status of an export that completed but
	// found chunk blobs already missing from the live store.
	ExitMissingBlobs = 3
)

// ExitError carries a process exit status other than 1.
type ExitError struct {
	Code int
	Err  error
}

func (e *ExitError) Error() string { return e.Err.Error() }
func (e *ExitError) Unwrap() error { return e.Err }

// Snapshot is the exported copy of the database, opened to list what it
// references.
type Snapshot interface {
	ChunkRefs(ctx context.Context) ([]store.ChunkRef, error)
	ExportCounts(ctx context.Context) (store.ExportCounts, error)
	ReleaseLease(ctx context.Context, name, holder string) error
	Close() error
}

// blobFiles is a blob store whose blobs are files (blob.FS).
type blobFiles interface {
	Path(key string) (string, error)
}

// Manifest is MANIFEST.json, written last: an export without one is
// incomplete.
type Manifest struct {
	ServerVersion string `json:"server_version"`
	CreatedAt     string `json:"created_at"`
	store.ExportCounts
	Linked  int            `json:"linked"`
	Copied  int            `json:"copied"`
	Missing []MissingChunk `json:"missing"`
}

// MissingChunk is a chunk the database lists whose blob was not in the live
// store when the export ran.
type MissingChunk struct {
	VaultID string `json:"vault_id"`
	ChunkID string `json:"chunk_id"`
	BlobKey string `json:"blob_key"`
}

// export writes a backup that obsync serve can start from (--out), or
// removes old ones (--prune).
func export(ctx context.Context, args []string, d Deps) error {
	fs := flag.NewFlagSet("export", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	out := fs.String("out", "", "")
	copyAll := fs.Bool("copy", false, "")
	wait := fs.Duration("wait", 2*time.Minute, "")
	prune := fs.String("prune", "", "")
	keep := fs.Int("keep", -1, "")
	if err := fs.Parse(args); err != nil || fs.NArg() > 0 {
		return errUsage
	}
	if *prune != "" {
		if *out != "" || *copyAll {
			return errUsage
		}
		if *keep < 1 {
			return errors.New("--prune needs --keep N, the number of newest exports to keep (at least 1)")
		}
		return exportPrune(*prune, *keep, d)
	}
	if *keep != -1 {
		return errUsage
	}
	if *out == "" {
		return errors.New("--out DIR is required: the new export's directory")
	}
	if !strings.HasPrefix(d.DatabaseURL, "file:") {
		return errors.New("export needs the local database file; for a libsql:// or http(s):// database, back it up on the database server")
	}
	files, ok := d.Blobs.(blobFiles)
	if !ok {
		return errors.New("export needs the fs blob backend")
	}
	if d.OpenSnapshot == nil {
		return errors.New("export is not available")
	}
	return exportTo(ctx, *out, *copyAll, *wait, files, d)
}

func exportTo(ctx context.Context, out string, copyAll bool, wait time.Duration, files blobFiles, d Deps) (err error) {
	created, err := prepareExportDir(out)
	if err != nil {
		return err
	}
	// A failed export leaves nothing behind: removing the links in it never
	// touches live blobs.
	defer func() {
		var exit *ExitError
		if err != nil && !errors.As(err, &exit) {
			cleanExportDir(out, created)
		}
	}()

	holder := "export-" + ids.New()
	if err := acquireExportLease(ctx, d.Store, holder, wait); err != nil {
		return err
	}
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	renewDone := make(chan struct{})
	go func() {
		defer close(renewDone)
		renewExportLease(ctx, d.Store, holder, cancel)
	}()
	defer func() {
		cancel(nil)
		<-renewDone
		rctx, rcancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer rcancel()
		if rerr := d.Store.ReleaseLease(rctx, jobs.LeaseName, holder); rerr != nil {
			fmt.Fprintf(d.Stdout, "warning: could not release the maintenance lease (it expires in %s): %v\n", exportLeaseTTL, rerr)
		}
	}()

	dbPath := filepath.Join(out, "meta.db")
	if err := d.Store.Snapshot(ctx, dbPath); err != nil {
		return exportErr(ctx, err)
	}
	refs, counts, err := readSnapshot(ctx, d, dbPath, holder)
	if err != nil {
		return exportErr(ctx, err)
	}

	m := Manifest{ServerVersion: d.Version, CreatedAt: now(d).UTC().Format(time.RFC3339), ExportCounts: counts, Missing: []MissingChunk{}}
	link := d.Link
	if link == nil {
		link = os.Link
	}
	blobRoot := filepath.Join(out, "blobs")
	dirs := map[string]bool{blobRoot: true}
	if err := os.Mkdir(blobRoot, 0o700); err != nil {
		return fmt.Errorf("create %s: %w", blobRoot, err)
	}
	toldCrossFS := false
	for _, r := range refs {
		if err := ctx.Err(); err != nil {
			return exportErr(ctx, err)
		}
		src, err := files.Path(r.BlobKey)
		if err != nil {
			return err
		}
		dst := filepath.Join(blobRoot, filepath.FromSlash(r.BlobKey))
		if err := mkdirs(blobRoot, filepath.Dir(dst), dirs); err != nil {
			return err
		}
		linked, err := placeBlob(src, dst, copyAll, link)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			m.Missing = append(m.Missing, MissingChunk{VaultID: r.VaultID, ChunkID: hex.EncodeToString(r.ChunkID), BlobKey: r.BlobKey})
			continue
		case err != nil:
			return err
		}
		if linked {
			m.Linked++
			continue
		}
		m.Copied++
		if !copyAll && !toldCrossFS {
			toldCrossFS = true
			fmt.Fprintln(d.Stdout, "the export is on another filesystem than the blobs: copying them instead of linking")
		}
	}
	if err := syncDirs(dirs); err != nil {
		return err
	}
	if err := writeManifest(out, m); err != nil {
		return err
	}
	fmt.Fprintf(d.Stdout, "exported %s, %s, %s and %s (%d bytes; %d linked, %d copied) to %s\n",
		plural(int(counts.Users), "user"), plural(int(counts.Vaults), "vault"), plural(int(counts.Versions), "version"),
		plural(int(counts.Chunks), "chunk"), counts.ChunkBytes, m.Linked, m.Copied, out)
	if n := len(m.Missing); n > 0 {
		return &ExitError{Code: ExitMissingBlobs, Err: fmt.Errorf(
			"%s already missing from the live store; the export is otherwise complete and lists them in %s",
			plural(n, "chunk blob"), filepath.Join(out, manifestName))}
	}
	return nil
}

// exportErr reports why the context ended when it did (the lease was lost),
// or err.
func exportErr(ctx context.Context, err error) error {
	if cause := context.Cause(ctx); cause != nil && !errors.Is(cause, context.Canceled) {
		return cause
	}
	return err
}

// prepareExportDir creates out (private to the server's user) or accepts it
// empty. created says whether it was made here.
func prepareExportDir(out string) (created bool, err error) {
	entries, err := os.ReadDir(out)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		if err := os.MkdirAll(out, 0o700); err != nil {
			return false, fmt.Errorf("create %s: %w", out, err)
		}
		return true, nil
	case err != nil:
		return false, fmt.Errorf("read %s: %w", out, err)
	case len(entries) > 0:
		return false, fmt.Errorf("%s is not empty: export into a new directory", out)
	}
	return false, nil
}

func cleanExportDir(out string, created bool) {
	if created {
		_ = os.RemoveAll(out)
		return
	}
	entries, _ := os.ReadDir(out)
	for _, e := range entries {
		_ = os.RemoveAll(filepath.Join(out, e.Name()))
	}
}

// acquireExportLease takes the maintenance lease, waiting up to wait while a
// maintenance pass (or another export) holds it.
func acquireExportLease(ctx context.Context, st Store, holder string, wait time.Duration) error {
	deadline := time.Now().Add(wait)
	for {
		ok, err := st.AcquireLease(ctx, jobs.LeaseName, holder, exportLeaseTTL)
		if err != nil {
			return err
		}
		if ok {
			return nil
		}
		left := time.Until(deadline)
		if left <= 0 {
			return errors.New("maintenance is running; try again (or wait longer with --wait)")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(min(left, exportLeasePoll)):
		}
	}
}

// renewExportLease keeps the lease until ctx ends. Losing it (a renewal
// refused or failing) cancels the export: maintenance could then delete
// chunks the snapshot lists.
func renewExportLease(ctx context.Context, st Store, holder string, cancel context.CancelCauseFunc) {
	t := time.NewTicker(exportLeaseRenew)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		ok, err := st.AcquireLease(ctx, jobs.LeaseName, holder, exportLeaseTTL)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			cancel(fmt.Errorf("could not renew the maintenance lease during the export, so nothing was kept; try again: %w", err))
			return
		}
		if !ok {
			cancel(errors.New("lost the maintenance lease during the export, so nothing was kept; try again"))
			return
		}
	}
}

// readSnapshot lists the snapshot's chunks and counts, and drops this
// export's lease from it: a server started on the export must not wait for
// the lease to expire.
func readSnapshot(ctx context.Context, d Deps, path, holder string) ([]store.ChunkRef, store.ExportCounts, error) {
	snap, err := d.OpenSnapshot(ctx, path)
	if err != nil {
		return nil, store.ExportCounts{}, fmt.Errorf("open the snapshot: %w", err)
	}
	defer snap.Close()
	if err := snap.ReleaseLease(ctx, jobs.LeaseName, holder); err != nil {
		return nil, store.ExportCounts{}, err
	}
	refs, err := snap.ChunkRefs(ctx)
	if err != nil {
		return nil, store.ExportCounts{}, err
	}
	counts, err := snap.ExportCounts(ctx)
	if err != nil {
		return nil, store.ExportCounts{}, err
	}
	return refs, counts, nil
}

// mkdirs creates dir and its parents below root, recording each in dirs so
// they can be synced at the end.
func mkdirs(root, dir string, dirs map[string]bool) error {
	if dirs[dir] {
		return nil
	}
	if parent := filepath.Dir(dir); parent != root && parent != dir {
		if err := mkdirs(root, parent, dirs); err != nil {
			return err
		}
	}
	if err := os.Mkdir(dir, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
		return fmt.Errorf("create %s: %w", dir, err)
	}
	dirs[dir] = true
	return nil
}

// placeBlob links src to dst, or copies it when asked to or when the two are
// on different filesystems. A missing src is fs.ErrNotExist.
func placeBlob(src, dst string, copyAll bool, link func(string, string) error) (linked bool, err error) {
	if !copyAll {
		err := link(src, dst)
		if err == nil {
			return true, nil
		}
		if !errors.Is(err, syscall.EXDEV) {
			if errors.Is(err, fs.ErrNotExist) {
				return false, fs.ErrNotExist
			}
			return false, fmt.Errorf("link blob: %w", err)
		}
	}
	return false, copyFile(src, dst)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return fs.ErrNotExist
		}
		return fmt.Errorf("copy blob: %w", err)
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("copy blob: %w", err)
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return fmt.Errorf("copy blob: %w", err)
	}
	if err := out.Sync(); err != nil {
		out.Close()
		return fmt.Errorf("sync blob copy: %w", err)
	}
	if err := out.Close(); err != nil {
		return fmt.Errorf("copy blob: %w", err)
	}
	return nil
}

// syncDirs fsyncs every directory the export created entries in, deepest
// first, then the export directory itself.
func syncDirs(dirs map[string]bool) error {
	list := make([]string, 0, len(dirs))
	for dir := range dirs {
		list = append(list, dir)
	}
	sort.Slice(list, func(i, j int) bool { return len(list[i]) > len(list[j]) })
	for _, dir := range list {
		if err := fsyncDir(dir); err != nil {
			return err
		}
	}
	return nil
}

func fsyncDir(dir string) error {
	f, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("sync %s: %w", dir, err)
	}
	defer f.Close()
	if err := f.Sync(); err != nil {
		return fmt.Errorf("sync %s: %w", dir, err)
	}
	return nil
}

// writeManifest writes MANIFEST.json and makes it, and everything before
// it, durable.
func writeManifest(out string, m Manifest) error {
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	p := filepath.Join(out, manifestName)
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("write manifest: %w", err)
	}
	if _, err := f.Write(append(b, '\n')); err != nil {
		f.Close()
		return fmt.Errorf("write manifest: %w", err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return fmt.Errorf("write manifest: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("write manifest: %w", err)
	}
	return fsyncDir(out)
}

// exportPrune removes all but the keep newest exports in root. Only
// directories holding a readable MANIFEST.json count as exports; anything
// else in root is left alone.
func exportPrune(root string, keep int, d Deps) error {
	entries, err := os.ReadDir(root)
	if err != nil {
		return fmt.Errorf("read %s: %w", root, err)
	}
	type found struct {
		name string
		at   time.Time
	}
	var exports []found
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		b, err := os.ReadFile(filepath.Join(root, e.Name(), manifestName))
		if err != nil {
			continue
		}
		var m Manifest
		if json.Unmarshal(b, &m) != nil {
			continue
		}
		at, err := time.Parse(time.RFC3339, m.CreatedAt)
		if err != nil {
			continue
		}
		exports = append(exports, found{e.Name(), at})
	}
	sort.Slice(exports, func(i, j int) bool { return exports[i].at.After(exports[j].at) })
	removed := 0
	for _, e := range exports[min(keep, len(exports)):] {
		if err := os.RemoveAll(filepath.Join(root, e.name)); err != nil {
			return fmt.Errorf("remove export %s: %w", e.name, err)
		}
		fmt.Fprintf(d.Stdout, "removed %s (exported %s)\n", e.name, e.at.Format(time.RFC3339))
		removed++
	}
	fmt.Fprintf(d.Stdout, "removed %s, kept %d\n", plural(removed, "export"), len(exports)-removed)
	return nil
}

func now(d Deps) time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}
