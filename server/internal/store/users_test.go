package store_test

import (
	"bytes"
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
)

var ctx = context.Background()

func TestCreateAndFindUserCaseInsensitively(t *testing.T) {
	st, clk := storetest.New(t)
	u := store.User{ID: ids.New(), Username: "Alice", PasswordHash: "h", QuotaBytes: 100}
	if err := st.CreateUser(ctx, u); err != nil {
		t.Fatal(err)
	}
	got, err := st.UserByUsername(ctx, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != u.ID || got.Username != "Alice" || got.QuotaBytes != 100 || got.CreatedAtMs != clk.Now().UnixMilli() {
		t.Fatalf("got %+v", got)
	}
	if err := st.CreateUser(ctx, store.User{ID: ids.New(), Username: "ALICE", PasswordHash: "h", QuotaBytes: 1}); !errors.Is(err, store.ErrExists) {
		t.Fatalf("duplicate username err = %v, want ErrExists", err)
	}
}

func TestUserNotFound(t *testing.T) {
	st, _ := storetest.New(t)
	if _, err := st.UserByUsername(ctx, "nobody"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
	if _, err := st.UserByID(ctx, ids.New()); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
	if err := st.SetPassword(ctx, ids.New(), "x"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
}

func TestSetPasswordAndListUsers(t *testing.T) {
	st, _ := storetest.New(t)
	bob := storetest.SeedUser(t, st, "bob")
	storetest.SeedUser(t, st, "alice")
	if err := st.SetPassword(ctx, bob.ID, "new-hash"); err != nil {
		t.Fatal(err)
	}
	got, _ := st.UserByID(ctx, bob.ID)
	if got.PasswordHash != "new-hash" {
		t.Fatalf("hash = %q", got.PasswordHash)
	}
	users, err := st.ListUsers(ctx)
	if err != nil || len(users) != 2 || users[0].Username != "alice" {
		t.Fatalf("users = %+v, err = %v", users, err)
	}
}

func TestDeviceLifecycle(t *testing.T) {
	st, clk := storetest.New(t)
	alice := storetest.SeedUser(t, st, "alice")
	bob := storetest.SeedUser(t, st, "bob")
	hash := bytes.Repeat([]byte{9}, 32)
	dev := store.Device{ID: ids.New(), UserID: alice.ID, Name: "laptop", Platform: "linux"}
	if err := st.CreateDevice(ctx, dev, hash); err != nil {
		t.Fatal(err)
	}
	got, err := st.DeviceByTokenHash(ctx, hash)
	if err != nil || got.ID != dev.ID || got.Revoked() || got.LastSeenAtMs != clk.Now().UnixMilli() {
		t.Fatalf("got %+v, err %v", got, err)
	}
	if _, err := st.DeviceByTokenHash(ctx, bytes.Repeat([]byte{8}, 32)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown hash err = %v", err)
	}

	clk.Advance(time.Hour)
	if err := st.TouchDevice(ctx, dev.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := st.DeviceByTokenHash(ctx, hash); got.LastSeenAtMs != clk.Now().UnixMilli() {
		t.Fatalf("last seen not updated: %+v", got)
	}

	if err := st.RevokeDevice(ctx, bob.ID, dev.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("revoking another user's device err = %v", err)
	}
	if err := st.RevokeDevice(ctx, alice.ID, dev.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := st.DeviceByTokenHash(ctx, hash); !got.Revoked() {
		t.Fatal("device not revoked")
	}
	devices, err := st.ListDevices(ctx, alice.ID)
	if err != nil || len(devices) != 1 || !devices[0].Revoked() {
		t.Fatalf("devices = %+v, err %v", devices, err)
	}
}

func TestKeyBundle(t *testing.T) {
	st, _ := storetest.New(t)
	u := storetest.SeedUser(t, st, "alice")
	if _, err := st.KeyBundle(ctx, u.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
	enc, sign := bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 32)
	if err := st.PutKeyBundle(ctx, u.ID, store.KeyBundle{PublicEncKey: enc, PublicSignKey: sign, Bundle: []byte("v1")}); err != nil {
		t.Fatal(err)
	}
	if err := st.PutKeyBundle(ctx, u.ID, store.KeyBundle{PublicEncKey: enc, PublicSignKey: sign, Bundle: []byte("v2")}); err != nil {
		t.Fatalf("re-wrapping with the same public keys must succeed: %v", err)
	}
	got, err := st.KeyBundle(ctx, u.ID)
	if err != nil || string(got.Bundle) != "v2" {
		t.Fatalf("got %+v, err %v", got, err)
	}
	err = st.PutKeyBundle(ctx, u.ID, store.KeyBundle{PublicEncKey: bytes.Repeat([]byte{3}, 32), PublicSignKey: sign, Bundle: []byte("v3")})
	if !errors.Is(err, store.ErrKeyMismatch) {
		t.Fatalf("changed public key err = %v, want ErrKeyMismatch", err)
	}
}

func TestPutKeyBundleRejectsBadPublicKeys(t *testing.T) {
	st, _ := storetest.New(t)
	u := storetest.SeedUser(t, st, "alice")
	good := bytes.Repeat([]byte{1}, 32)
	for name, kb := range map[string]store.KeyBundle{
		"empty enc":  {PublicEncKey: nil, PublicSignKey: good, Bundle: []byte("b")},
		"short enc":  {PublicEncKey: good[:31], PublicSignKey: good, Bundle: []byte("b")},
		"long sign":  {PublicEncKey: good, PublicSignKey: append(bytes.Clone(good), 0), Bundle: []byte("b")},
		"empty sign": {PublicEncKey: good, PublicSignKey: []byte{}, Bundle: []byte("b")},
	} {
		if err := st.PutKeyBundle(ctx, u.ID, kb); !errors.Is(err, store.ErrInvalid) {
			t.Errorf("%s: err = %v, want ErrInvalid", name, err)
		}
	}
	if _, err := st.KeyBundle(ctx, u.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a rejected bundle was stored: err = %v", err)
	}
}

// Two servers (or two stores on one file) racing to store a user's first
// bundle: the same keys both succeed, different keys yield ErrKeyMismatch.
func TestPutKeyBundleConcurrentFirstUpload(t *testing.T) {
	for i := 0; i < 5; i++ {
		path := "file:" + filepath.Join(t.TempDir(), "meta.db")
		a, err := store.Open(ctx, store.Options{URL: path})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = a.Close() })
		if err := a.Migrate(ctx); err != nil {
			t.Fatal(err)
		}
		b, err := store.Open(ctx, store.Options{URL: path})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = b.Close() })
		u := storetest.SeedUser(t, a, "alice")

		enc, sign := bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 32)
		other := bytes.Repeat([]byte{3}, 32)
		bundles := []store.KeyBundle{
			{PublicEncKey: enc, PublicSignKey: sign, Bundle: []byte("a")},
			{PublicEncKey: enc, PublicSignKey: sign, Bundle: []byte("b")},
			{PublicEncKey: other, PublicSignKey: sign, Bundle: []byte("c")},
		}
		stores := []*store.Store{a, b, a}
		errs := make([]error, len(bundles))
		var wg sync.WaitGroup
		for j := range bundles {
			wg.Add(1)
			go func() {
				defer wg.Done()
				errs[j] = stores[j].PutKeyBundle(ctx, u.ID, bundles[j])
			}()
		}
		wg.Wait()
		got, err := a.KeyBundle(ctx, u.ID)
		if err != nil {
			t.Fatal(err)
		}
		for j, err := range errs {
			sameAsStored := bytes.Equal(bundles[j].PublicEncKey, got.PublicEncKey)
			switch {
			case sameAsStored && err != nil:
				t.Fatalf("round %d: put %d with the stored keys: %v", i, j, err)
			case !sameAsStored && !errors.Is(err, store.ErrKeyMismatch):
				t.Fatalf("round %d: put %d with other keys: err = %v, want ErrKeyMismatch", i, j, err)
			}
		}
	}
}
