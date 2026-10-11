package admin_test

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/admin"
	"github.com/jfms7s/obsidian-sync/server/internal/blob"
	"github.com/jfms7s/obsidian-sync/server/internal/config"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/jobs"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
)

// exportEnv is a live store with blobs on disk, as obsync serve keeps them.
type exportEnv struct {
	t        *testing.T
	st       *store.Store
	clk      *storetest.Clock
	blobs    *blob.FS
	blobRoot string
	// content is every stored chunk's bytes by blob key.
	content map[string][]byte
}

func newExportEnv(t *testing.T) *exportEnv {
	t.Helper()
	st, clk := storetest.New(t)
	root := t.TempDir()
	blobs, err := blob.NewFS(root)
	if err != nil {
		t.Fatal(err)
	}
	return &exportEnv{t: t, st: st, clk: clk, blobs: blobs, blobRoot: root, content: map[string][]byte{}}
}

// chunk stores a chunk's blob and row and returns its id.
func (e *exportEnv) chunk(vaultID string, data string) []byte {
	e.t.Helper()
	id := ids.Bytes(32)
	key := vaultID + "/" + hex.EncodeToString(id[:1]) + "/" + ids.New()
	if err := e.blobs.Put(ctx, key, strings.NewReader(data)); err != nil {
		e.t.Fatal(err)
	}
	if _, err := e.st.InsertChunk(ctx, store.Chunk{VaultID: vaultID, ChunkID: id, BlobKey: key, Size: int64(len(data))}); err != nil {
		e.t.Fatal(err)
	}
	e.content[key] = []byte(data)
	return id
}

func (e *exportEnv) deps(args ...func(*admin.Deps)) (admin.Deps, *bytes.Buffer) {
	d, out := deps(e.t, e.st, e.blobs, "")
	d.DatabaseURL = "file:/data/meta.db"
	d.Version = "1.2.3-test"
	d.OpenSnapshot = func(ctx context.Context, path string) (admin.Snapshot, error) {
		return store.Open(ctx, store.Options{URL: "file:" + path})
	}
	for _, f := range args {
		f(&d)
	}
	return d, out
}

// seed builds two users with several vaults, versions, a deletion and an
// uploaded but never committed chunk.
func (e *exportEnv) seed() {
	e.t.Helper()
	alice := storetest.SeedUser(e.t, e.st, "alice")
	bob := storetest.SeedUser(e.t, e.st, "bob")
	for _, owner := range []store.User{alice, alice, bob} {
		v := storetest.SeedVault(e.t, e.st, owner.ID)
		a1 := e.chunk(v.ID, "first version of a")
		a2 := e.chunk(v.ID, "second version of a")
		shared := e.chunk(v.ID, "a chunk both files use")
		fa := ids.Bytes(32)
		va := storetest.MustCommit(e.t, e.st, storetest.NewVersion(v.ID, fa, nil, a1, shared))
		storetest.MustCommit(e.t, e.st, storetest.NewVersion(v.ID, fa, va.VersionID, a2, shared))
		fb := ids.Bytes(32)
		vb := storetest.MustCommit(e.t, e.st, storetest.NewVersion(v.ID, fb, nil, shared, e.chunk(v.ID, "b")))
		del := storetest.NewVersion(v.ID, fb, vb.VersionID)
		del.Deleted = true
		storetest.MustCommit(e.t, e.st, del)
		e.chunk(v.ID, "uploaded, not committed yet")
	}
}

func readManifest(t *testing.T, dir string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "MANIFEST.json"))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("manifest: %v\n%s", err, b)
	}
	return m
}

// The export is a data directory: obsync's store and blob store opened on it
// serve every chunk of every version byte for byte.
func TestExportRoundTrip(t *testing.T) {
	e := newExportEnv(t)
	e.seed()
	out := filepath.Join(t.TempDir(), "export", "2026-10-11")
	d, stdout := e.deps()
	if err := admin.Run(ctx, []string{"export", "--out", out}, d); err != nil {
		t.Fatal(err)
	}

	exp, err := store.Open(ctx, store.Options{URL: "file:" + filepath.Join(out, "meta.db")})
	if err != nil {
		t.Fatal(err)
	}
	defer exp.Close()
	if err := exp.Migrate(ctx); err != nil {
		t.Fatalf("serve migrates the export on start: %v", err)
	}
	expBlobs, err := blob.NewFS(filepath.Join(out, "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	users, _ := exp.ListUsers(ctx)
	checked := 0
	for _, u := range users {
		vaults, _ := exp.ListVaults(ctx, u.ID)
		for _, v := range vaults {
			versions, err := exp.Changes(ctx, v.ID, 0, 1000)
			if err != nil {
				t.Fatal(err)
			}
			for _, ver := range versions {
				hist, _ := exp.History(ctx, v.ID, ver.FileID)
				for _, h := range hist {
					for _, c := range h.ChunkIDs {
						key, _, err := exp.ChunkBlob(ctx, v.ID, c)
						if err != nil {
							t.Fatalf("chunk row missing from export: %v", err)
						}
						rc, err := expBlobs.Get(ctx, key)
						if err != nil {
							t.Fatalf("blob %s missing from export: %v", key, err)
						}
						got, _ := io.ReadAll(rc)
						rc.Close()
						if !bytes.Equal(got, e.content[key]) {
							t.Fatalf("blob %s = %q, want %q", key, got, e.content[key])
						}
						checked++
					}
				}
			}
		}
	}
	if len(users) != 2 || checked < 12 {
		t.Fatalf("checked %d chunk reads over %d users; the seed has more", checked, len(users))
	}
	// Uncommitted chunks come along too, and every blob is a hard link.
	refs, _ := exp.ChunkRefs(ctx)
	if len(refs) != len(e.content) {
		t.Fatalf("export has %d chunks, live store %d", len(refs), len(e.content))
	}
	for _, r := range refs {
		live, _ := os.Stat(filepath.Join(e.blobRoot, r.BlobKey))
		copied, err := os.Stat(filepath.Join(out, "blobs", r.BlobKey))
		if err != nil || !os.SameFile(live, copied) {
			t.Fatalf("blob %s is not a link to the live file (err %v)", r.BlobKey, err)
		}
	}

	m := readManifest(t, out)
	if m["server_version"] != "1.2.3-test" || m["users"] != float64(2) || m["vaults"] != float64(3) ||
		m["chunks"] != float64(len(e.content)) || m["linked"] != float64(len(e.content)) || m["copied"] != float64(0) {
		t.Fatalf("manifest = %v", m)
	}
	if missing, ok := m["missing"].([]any); !ok || len(missing) != 0 {
		t.Fatalf("manifest missing = %v, want an empty list", m["missing"])
	}
	if _, err := time.Parse(time.RFC3339, m["created_at"].(string)); err != nil {
		t.Fatalf("created_at: %v", err)
	}
	if !strings.Contains(stdout.String(), "exported 2 users, 3 vaults") {
		t.Fatalf("output = %q", stdout)
	}
	// The lease is free again, in the live store and in the export (a
	// restored server must not wait for it to expire).
	for name, s := range map[string]*store.Store{"live": e.st, "export": exp} {
		if ok, _ := s.AcquireLease(ctx, jobs.LeaseName, "other", time.Minute); !ok {
			t.Fatalf("%s store: the maintenance lease is still held", name)
		}
	}
}

func TestExportCopy(t *testing.T) {
	e := newExportEnv(t)
	e.seed()
	out := filepath.Join(t.TempDir(), "x")
	d, _ := e.deps()
	if err := admin.Run(ctx, []string{"export", "--out", out, "--copy"}, d); err != nil {
		t.Fatal(err)
	}
	for key, want := range e.content {
		live, _ := os.Stat(filepath.Join(e.blobRoot, key))
		p := filepath.Join(out, "blobs", key)
		copied, err := os.Stat(p)
		if err != nil || os.SameFile(live, copied) {
			t.Fatalf("blob %s: not a separate copy (err %v)", key, err)
		}
		if got, _ := os.ReadFile(p); !bytes.Equal(got, want) {
			t.Fatalf("copy of %s = %q", key, got)
		}
	}
	m := readManifest(t, out)
	if m["copied"] != float64(len(e.content)) || m["linked"] != float64(0) {
		t.Fatalf("manifest = %v", m)
	}
}

// Across filesystems a link fails with EXDEV: those blobs are copied, and the
// operator is told once.
func TestExportFallsBackToCopyAcrossFilesystems(t *testing.T) {
	e := newExportEnv(t)
	e.seed()
	out := filepath.Join(t.TempDir(), "x")
	d, stdout := e.deps(func(d *admin.Deps) {
		d.Link = func(oldname, newname string) error {
			return &os.LinkError{Op: "link", Old: oldname, New: newname, Err: syscall.EXDEV}
		}
	})
	if err := admin.Run(ctx, []string{"export", "--out", out}, d); err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(stdout.String(), "another filesystem"); n != 1 {
		t.Fatalf("output mentions the fallback %d times: %q", n, stdout)
	}
	for key, want := range e.content {
		if got, _ := os.ReadFile(filepath.Join(out, "blobs", key)); !bytes.Equal(got, want) {
			t.Fatalf("copy of %s = %q", key, got)
		}
	}
	if m := readManifest(t, out); m["copied"] != float64(len(e.content)) {
		t.Fatalf("manifest = %v", m)
	}
}

// A blob already missing from the live store is listed, the rest is
// exported, and the exit status is 3.
func TestExportReportsMissingBlobs(t *testing.T) {
	e := newExportEnv(t)
	e.seed()
	var gone string
	for k := range e.content {
		gone = k
		break
	}
	if err := os.Remove(filepath.Join(e.blobRoot, gone)); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "x")
	d, _ := e.deps()
	err := admin.Run(ctx, []string{"export", "--out", out}, d)
	var exit *admin.ExitError
	if !errors.As(err, &exit) || exit.Code != 3 || !strings.Contains(err.Error(), "1 chunk blob") {
		t.Fatalf("err = %v, want exit status 3 naming one missing blob", err)
	}
	m := readManifest(t, out)
	missing, _ := m["missing"].([]any)
	if len(missing) != 1 || missing[0].(map[string]any)["blob_key"] != gone {
		t.Fatalf("manifest missing = %v, want %s", m["missing"], gone)
	}
	if m["linked"] != float64(len(e.content)-1) {
		t.Fatalf("manifest = %v", m)
	}
}

// While the export holds the maintenance lease, a maintenance pass deletes
// nothing; once it is done, the same pass collects the dead chunk.
func TestExportHoldsOffMaintenance(t *testing.T) {
	e := newExportEnv(t)
	u := storetest.SeedUser(t, e.st, "alice")
	v := storetest.SeedVault(t, e.st, u.ID)
	dead := e.chunk(v.ID, "never committed")
	e.clk.Advance(2 * time.Hour) // past the GC grace below
	runner := jobs.New(e.st, e.blobs, jobs.Config{Interval: time.Hour, Retention: config.Retention{TrashDays: 30}, GCGrace: time.Hour},
		e.clk.Now, slog.New(slog.NewTextHandler(io.Discard, nil)))

	ranDuringExport := false
	d, _ := e.deps(func(d *admin.Deps) {
		d.Link = func(oldname, newname string) error {
			if !ranDuringExport {
				ranDuringExport = true
				if err := runner.RunOnce(ctx); err != nil {
					t.Errorf("RunOnce: %v", err)
				}
			}
			return os.Link(oldname, newname)
		}
	})
	if err := admin.Run(ctx, []string{"export", "--out", filepath.Join(t.TempDir(), "x")}, d); err != nil {
		t.Fatal(err)
	}
	if !ranDuringExport {
		t.Fatal("the hook never ran")
	}
	if _, _, err := e.st.ChunkBlob(ctx, v.ID, dead); err != nil {
		t.Fatalf("maintenance collected a chunk during the export: %v", err)
	}
	if err := runner.RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.st.ChunkBlob(ctx, v.ID, dead); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("after the export the dead chunk should be collected: %v", err)
	}
}

// While maintenance runs (another holder has the lease), the export waits up
// to --wait and then gives up, leaving no partial export behind.
func TestExportWaitsForMaintenanceThenFails(t *testing.T) {
	e := newExportEnv(t)
	e.seed()
	if ok, _ := e.st.AcquireLease(ctx, jobs.LeaseName, "serve-runner", time.Hour); !ok {
		t.Fatal("setup: lease not taken")
	}
	out := filepath.Join(t.TempDir(), "x")
	d, _ := e.deps()
	start := time.Now()
	err := admin.Run(ctx, []string{"export", "--out", out, "--wait", "300ms"}, d)
	if err == nil || !strings.Contains(err.Error(), "maintenance is running; try again") {
		t.Fatalf("err = %v", err)
	}
	if waited := time.Since(start); waited < 300*time.Millisecond {
		t.Fatalf("gave up after %v, before --wait", waited)
	}
	if _, err := os.Stat(out); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a partial export was left behind: %v", err)
	}

	// Released during the wait: the export goes ahead.
	go func() {
		time.Sleep(200 * time.Millisecond)
		_ = e.st.ReleaseLease(context.Background(), jobs.LeaseName, "serve-runner")
	}()
	if err := admin.Run(ctx, []string{"export", "--out", out, "--wait", "10s"}, d); err != nil {
		t.Fatal(err)
	}
}

func TestExportRefusals(t *testing.T) {
	e := newExportEnv(t)
	full := t.TempDir()
	if err := os.WriteFile(filepath.Join(full, "something"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	for name, tc := range map[string]struct {
		args []string
		url  string
		want string
	}{
		"non-empty out":      {[]string{"export", "--out", full}, "", "is not empty"},
		"remote database":    {[]string{"export", "--out", filepath.Join(t.TempDir(), "x")}, "libsql://db.example.com", "local database file"},
		"no out":             {[]string{"export"}, "", "--out"},
		"keep without prune": {[]string{"export", "--out", filepath.Join(t.TempDir(), "x"), "--keep", "2"}, "", "usage"},
		"prune without keep": {[]string{"export", "--prune", t.TempDir()}, "", "--keep"},
		"stray argument":     {[]string{"export", "--out", filepath.Join(t.TempDir(), "x"), "now"}, "", "usage"},
	} {
		d, _ := e.deps(func(d *admin.Deps) {
			if tc.url != "" {
				d.DatabaseURL = tc.url
			}
		})
		err := admin.Run(ctx, tc.args, d)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: err = %v, want it to mention %q", name, err, tc.want)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(full, "something")); string(b) != "x" {
		t.Fatal("the non-empty --out was changed")
	}
}

func TestExportIntoAnEmptyExistingDirectory(t *testing.T) {
	e := newExportEnv(t)
	e.seed()
	out := t.TempDir()
	d, _ := e.deps()
	if err := admin.Run(ctx, []string{"export", "--out", out}, d); err != nil {
		t.Fatal(err)
	}
	readManifest(t, out)
}

func TestExportPrune(t *testing.T) {
	e := newExportEnv(t)
	e.seed()
	root := t.TempDir()
	d, out := e.deps(func(d *admin.Deps) {
		times := []time.Time{
			time.Date(2026, 10, 9, 3, 0, 0, 0, time.UTC),
			time.Date(2026, 10, 11, 3, 0, 0, 0, time.UTC),
			time.Date(2026, 10, 10, 3, 0, 0, 0, time.UTC),
		}
		d.Now = func() time.Time { t := times[0]; times = times[1:]; return t }
	})
	for _, name := range []string{"a", "b", "c"} {
		if err := admin.Run(ctx, []string{"export", "--out", filepath.Join(root, name)}, d); err != nil {
			t.Fatal(err)
		}
	}
	// Not an export (no manifest): never touched.
	if err := os.MkdirAll(filepath.Join(root, "notes"), 0o700); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if err := admin.Run(ctx, []string{"export", "--prune", root, "--keep", "1"}, d); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(root)
	var left []string
	for _, en := range entries {
		left = append(left, en.Name())
	}
	if strings.Join(left, ",") != "b,notes" {
		t.Fatalf("left = %v, want the newest export (b) and the unrelated folder", left)
	}
	if !strings.Contains(out.String(), "removed 2 exports") {
		t.Fatalf("output = %q", out)
	}
	// The live blobs are untouched by removing their links.
	for key := range e.content {
		if _, err := os.Stat(filepath.Join(e.blobRoot, key)); err != nil {
			t.Fatalf("live blob %s: %v", key, err)
		}
	}
	d2, _ := e.deps()
	if err := admin.Run(ctx, []string{"export", "--prune", root, "--keep", "0"}, d2); err == nil {
		t.Fatal("--keep 0 accepted")
	}
}
