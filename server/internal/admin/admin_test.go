package admin_test

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/admin"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	"github.com/jfms7s/obsidian-sync/server/internal/blob"
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
	if err := admin.Run(ctx, []string{"user", "delete", "--username", "alice"}, d); err != nil {
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
