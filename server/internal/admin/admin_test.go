package admin_test

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/admin"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	"github.com/jfms7s/obsidian-sync/server/internal/blob"
	"github.com/jfms7s/obsidian-sync/server/internal/jobs"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
)

var ctx = context.Background()

func deps(t *testing.T, st *store.Store, blobs blob.Store, stdin string) (admin.Deps, *bytes.Buffer) {
	t.Helper()
	out := &bytes.Buffer{}
	return admin.Deps{Store: st, Blobs: blobs, DefaultQuotaBytes: 1 << 30, Params: auth.FastParams,
		Stdin: strings.NewReader(stdin), Stdout: out}, out
}

func TestUserCreateListSetPasswordDelete(t *testing.T) {
	st, _ := storetest.New(t)
	blobs, _ := blob.NewFS(t.TempDir())

	d, out := deps(t, st, blobs, "correct horse\n")
	if err := admin.Run(ctx, []string{"user", "create", "--username", "alice", "--quota-bytes", "5000"}, d); err != nil {
		t.Fatal(err)
	}
	u, err := st.UserByUsername(ctx, "alice")
	if err != nil || u.QuotaBytes != 5000 {
		t.Fatalf("user = %+v, err %v", u, err)
	}
	if ok, _ := auth.VerifyPassword("correct horse", u.PasswordHash); !ok {
		t.Fatal("password not set")
	}
	if !strings.Contains(out.String(), "created user alice") {
		t.Fatalf("output = %q", out)
	}

	d, _ = deps(t, st, blobs, "another one\n")
	if err := admin.Run(ctx, []string{"user", "create", "--username", "alice"}, d); err == nil {
		t.Fatal("duplicate user created")
	}

	d, out = deps(t, st, blobs, "")
	if err := admin.Run(ctx, []string{"user", "list"}, d); err != nil || !strings.Contains(out.String(), "alice") {
		t.Fatalf("list = %q, err %v", out, err)
	}

	d, _ = deps(t, st, blobs, "battery staple\n")
	if err := admin.Run(ctx, []string{"user", "set-password", "--username", "alice"}, d); err != nil {
		t.Fatal(err)
	}
	u, _ = st.UserByUsername(ctx, "alice")
	if ok, _ := auth.VerifyPassword("battery staple", u.PasswordHash); !ok {
		t.Fatal("password not changed")
	}

	vault := storetest.SeedVault(t, st, u.ID)
	key := "v/" + vault.ID
	_ = blobs.Put(ctx, key, strings.NewReader("cipher"))
	if _, err := st.InsertChunk(ctx, store.Chunk{VaultID: vault.ID, ChunkID: storetest.ChunkID(1), BlobKey: key, Size: 6}); err != nil {
		t.Fatal(err)
	}
	d, _ = deps(t, st, blobs, "")
	if err := admin.Run(ctx, []string{"user", "delete", "--username", "alice", "--yes"}, d); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UserByUsername(ctx, "alice"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("user still there: %v", err)
	}
	if _, err := blobs.Get(ctx, key); !errors.Is(err, blob.ErrNotFound) {
		t.Fatalf("blob still there: %v", err)
	}
}

func TestUserCreateValidation(t *testing.T) {
	st, _ := storetest.New(t)
	blobs, _ := blob.NewFS(t.TempDir())
	for name, tc := range map[string]struct {
		args  []string
		stdin string
	}{
		"short password": {[]string{"user", "create", "--username", "bob"}, "short\n"},
		"no username":    {[]string{"user", "create"}, "long enough\n"},
		"bad username":   {[]string{"user", "create", "--username", "bob smith"}, "long enough\n"},
		"unknown verb":   {[]string{"user", "frobnicate"}, ""},
		"no subcommand":  {nil, ""},
	} {
		d, _ := deps(t, st, blobs, tc.stdin)
		if err := admin.Run(ctx, tc.args, d); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

// A password longer than auth.Login accepts would create an account that can
// never log in, so create and set-password both refuse it.
func TestOverlongPasswordRejected(t *testing.T) {
	st, _ := storetest.New(t)
	blobs, _ := blob.NewFS(t.TempDir())
	long := strings.Repeat("x", 1025) + "\n"

	d, _ := deps(t, st, blobs, long)
	if err := admin.Run(ctx, []string{"user", "create", "--username", "carol"}, d); err == nil {
		t.Fatal("created a user with a 1025-byte password")
	}
	if _, err := st.UserByUsername(ctx, "carol"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("user was stored: %v", err)
	}

	d, _ = deps(t, st, blobs, strings.Repeat("x", 1024)+"\n")
	if err := admin.Run(ctx, []string{"user", "create", "--username", "carol"}, d); err != nil {
		t.Fatalf("1024-byte password rejected: %v", err)
	}

	d, _ = deps(t, st, blobs, long)
	if err := admin.Run(ctx, []string{"user", "set-password", "--username", "carol"}, d); err == nil {
		t.Fatal("set a 1025-byte password")
	}
	u, _ := st.UserByUsername(ctx, "carol")
	if ok, _ := auth.VerifyPassword(strings.Repeat("x", 1024), u.PasswordHash); !ok {
		t.Fatal("password changed despite the error")
	}
}

// --quota-bytes is decimal only: flag.Int64 would read "010" as octal 8.
func TestQuotaBytesIsDecimal(t *testing.T) {
	st, _ := storetest.New(t)
	blobs, _ := blob.NewFS(t.TempDir())
	d, _ := deps(t, st, blobs, "correct horse\n")
	if err := admin.Run(ctx, []string{"user", "create", "--username", "dave", "--quota-bytes", "010"}, d); err != nil {
		t.Fatal(err)
	}
	if u, _ := st.UserByUsername(ctx, "dave"); u.QuotaBytes != 10 {
		t.Fatalf("quota = %d, want 10", u.QuotaBytes)
	}
	for _, q := range []string{"0x10", "1e9", "-5", "0", "abc"} {
		d, _ := deps(t, st, blobs, "correct horse\n")
		if err := admin.Run(ctx, []string{"user", "create", "--username", "erin", "--quota-bytes", q}, d); err == nil {
			t.Errorf("--quota-bytes %s accepted", q)
		}
	}
}

// seedDevices logs alice in twice (two devices) through the real auth service.
func seedDevices(t *testing.T, st *store.Store) (*auth.Service, []string) {
	t.Helper()
	svc, err := auth.NewService(st, auth.Options{Params: auth.FastParams})
	if err != nil {
		t.Fatal(err)
	}
	var tokens []string
	for _, name := range []string{"laptop", "phone"} {
		res, err := svc.Login(ctx, auth.LoginRequest{Username: "alice", Password: "correct horse", DeviceName: name, Platform: "linux"})
		if err != nil {
			t.Fatal(err)
		}
		tokens = append(tokens, res.Token)
	}
	return svc, tokens
}

func createAlice(t *testing.T, st *store.Store, blobs blob.Store) {
	t.Helper()
	d, _ := deps(t, st, blobs, "correct horse\n")
	if err := admin.Run(ctx, []string{"user", "create", "--username", "alice"}, d); err != nil {
		t.Fatal(err)
	}
}

func TestDeviceListAndRevoke(t *testing.T) {
	st, _ := storetest.New(t)
	blobs, _ := blob.NewFS(t.TempDir())
	createAlice(t, st, blobs)
	svc, tokens := seedDevices(t, st)
	u, _ := st.UserByUsername(ctx, "alice")
	devices, _ := st.ListDevices(ctx, u.ID)
	// Both devices were created in the same millisecond, so list order is by
	// random id: put the laptop (tokens[0]) first.
	if devices[0].Name != "laptop" {
		devices[0], devices[1] = devices[1], devices[0]
	}

	d, out := deps(t, st, blobs, "")
	if err := admin.Run(ctx, []string{"device", "list", "--username", "alice"}, d); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"ID", "LAST_SEEN", "REVOKED", devices[0].ID, "laptop", "phone", "linux", "Z"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("device list does not show %q:\n%s", want, out)
		}
	}

	d, out = deps(t, st, blobs, "")
	if err := admin.Run(ctx, []string{"device", "revoke", "--username", "alice", "--id", devices[0].ID}, d); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "revoked 1 device") {
		t.Fatalf("output = %q", out)
	}
	if _, err := svc.Authenticate(ctx, tokens[0]); !errors.Is(err, auth.ErrDeviceRevoked) {
		t.Fatalf("revoked device still authenticates: %v", err)
	}
	if _, err := svc.Authenticate(ctx, tokens[1]); err != nil {
		t.Fatalf("the other device was revoked too: %v", err)
	}

	d, out = deps(t, st, blobs, "")
	if err := admin.Run(ctx, []string{"device", "revoke", "--username", "alice", "--all"}, d); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "revoked 1 device") {
		t.Fatalf("output = %q", out)
	}
	if _, err := svc.Authenticate(ctx, tokens[1]); !errors.Is(err, auth.ErrDeviceRevoked) {
		t.Fatalf("revoke --all left a device signed in: %v", err)
	}

	for name, args := range map[string][]string{
		"neither":        {"device", "revoke", "--username", "alice"},
		"both":           {"device", "revoke", "--username", "alice", "--all", "--id", devices[0].ID},
		"unknown id":     {"device", "revoke", "--username", "alice", "--id", "nope"},
		"unknown user":   {"device", "list", "--username", "zed"},
		"no username":    {"device", "list"},
		"unknown action": {"device", "frobnicate"},
	} {
		d, _ := deps(t, st, blobs, "")
		if err := admin.Run(ctx, args, d); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

func TestSetPasswordCanRevokeDevices(t *testing.T) {
	st, _ := storetest.New(t)
	blobs, _ := blob.NewFS(t.TempDir())
	createAlice(t, st, blobs)
	svc, tokens := seedDevices(t, st)

	d, out := deps(t, st, blobs, "battery staple\n")
	if err := admin.Run(ctx, []string{"user", "set-password", "--username", "alice"}, d); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "--revoke-devices") {
		t.Fatalf("without the flag the output should point at it: %q", out)
	}
	if _, err := svc.Authenticate(ctx, tokens[0]); err != nil {
		t.Fatalf("devices were revoked without the flag: %v", err)
	}

	d, out = deps(t, st, blobs, "correct horse\n")
	if err := admin.Run(ctx, []string{"user", "set-password", "--username", "alice", "--revoke-devices"}, d); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "revoked 2 devices") {
		t.Fatalf("output = %q", out)
	}
	for _, tok := range tokens {
		if _, err := svc.Authenticate(ctx, tok); !errors.Is(err, auth.ErrDeviceRevoked) {
			t.Fatalf("device still signed in after --revoke-devices: %v", err)
		}
	}
}

// seedAliceData gives alice a vault with one committed version and its blob.
func seedAliceData(t *testing.T, st *store.Store, blobs blob.Store, keys ...string) {
	t.Helper()
	u, _ := st.UserByUsername(ctx, "alice")
	vault := storetest.SeedVault(t, st, u.ID)
	for i, key := range keys {
		_ = blobs.Put(ctx, key, strings.NewReader("cipher"))
		if _, err := st.InsertChunk(ctx, store.Chunk{VaultID: vault.ID, ChunkID: storetest.ChunkID(byte(i + 1)), BlobKey: key, Size: 6}); err != nil {
			t.Fatal(err)
		}
	}
	storetest.MustCommit(t, st, storetest.NewVersion(vault.ID, storetest.FileID(1), nil, storetest.ChunkID(1)))
}

func TestUserDeleteNeedsYes(t *testing.T) {
	st, _ := storetest.New(t)
	blobs, _ := blob.NewFS(t.TempDir())
	createAlice(t, st, blobs)
	seedAliceData(t, st, blobs, "k/1", "k/2")

	d, out := deps(t, st, blobs, "")
	err := admin.Run(ctx, []string{"user", "delete", "--username", "alice"}, d)
	if err == nil || !strings.Contains(err.Error(), "--yes") {
		t.Fatalf("err = %v, want a refusal pointing at --yes", err)
	}
	for _, want := range []string{"1 vault", "1 version", "2 blobs"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("summary does not say %q: %q", want, out)
		}
	}
	if _, err := st.UserByUsername(ctx, "alice"); err != nil {
		t.Fatalf("user deleted without --yes: %v", err)
	}
	if _, err := blobs.Get(ctx, "k/1"); err != nil {
		t.Fatalf("blob deleted without --yes: %v", err)
	}

	d, _ = deps(t, st, blobs, "")
	if err := admin.Run(ctx, []string{"user", "delete", "--username", "alice", "--yes"}, d); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UserByUsername(ctx, "alice"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("user still there: %v", err)
	}
}

// failingDeletes fails Delete for the keys in fail.
type failingDeletes struct {
	blob.Store
	fail map[string]bool
}

func (f failingDeletes) Delete(ctx context.Context, key string) error {
	if f.fail[key] {
		return errors.New("disk on fire")
	}
	return f.Store.Delete(ctx, key)
}

func TestUserDeleteReportsBlobsItCouldNotRemove(t *testing.T) {
	st, _ := storetest.New(t)
	fs, _ := blob.NewFS(t.TempDir())
	blobs := failingDeletes{Store: fs, fail: map[string]bool{"k/2": true}}
	createAlice(t, st, blobs)
	seedAliceData(t, st, blobs, "k/1", "k/2", "k/3")

	d, out := deps(t, st, blobs, "")
	if err := admin.Run(ctx, []string{"user", "delete", "--username", "alice", "--yes"}, d); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "2 blobs removed, 1 could not be removed") {
		t.Fatalf("output = %q", out)
	}
}

func TestMaintenanceRun(t *testing.T) {
	st, _ := storetest.New(t)
	blobs, _ := blob.NewFS(t.TempDir())
	var got time.Time
	maintenance := func(_ context.Context, now time.Time) (jobs.Report, error) {
		got = now
		return jobs.Report{VersionsPruned: 3, FilesPurged: 2, ChunksDeleted: 7}, nil
	}

	d, out := deps(t, st, blobs, "")
	d.Maintenance = maintenance
	if err := admin.Run(ctx, []string{"maintenance", "run", "--as-of", "2027-01-02T03:04:05Z"}, d); err != nil {
		t.Fatal(err)
	}
	if want := time.Date(2027, 1, 2, 3, 4, 5, 0, time.UTC); !got.Equal(want) {
		t.Fatalf("now = %v, want %v", got, want)
	}
	for _, want := range []string{"2027-01-02T03:04:05Z", "3 versions pruned", "2 files purged", "7 chunks deleted"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("output %q does not say %q", out, want)
		}
	}

	d, _ = deps(t, st, blobs, "")
	d.Maintenance = maintenance
	before := time.Now()
	if err := admin.Run(ctx, []string{"maintenance", "run"}, d); err != nil {
		t.Fatal(err)
	}
	if got.Before(before) || time.Since(got) > time.Minute {
		t.Fatalf("without --as-of, now = %v, want the current time", got)
	}

	for _, bad := range [][]string{{"maintenance", "run", "--as-of", "yesterday"}, {"maintenance", "run", "extra"}, {"maintenance"}} {
		d, _ := deps(t, st, blobs, "")
		d.Maintenance = maintenance
		if err := admin.Run(ctx, bad, d); err == nil {
			t.Errorf("%v: expected an error", bad)
		}
	}

	d, _ = deps(t, st, blobs, "")
	d.Maintenance = func(context.Context, time.Time) (jobs.Report, error) { return jobs.Report{}, jobs.ErrLeaseHeld }
	if err := admin.Run(ctx, []string{"maintenance", "run"}, d); err == nil || !strings.Contains(err.Error(), "stop the server") {
		t.Fatalf("err = %v, want advice to stop the server", err)
	}
}
