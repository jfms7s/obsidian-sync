package store_test

import (
	"errors"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
)

func TestVaultLifecycle(t *testing.T) {
	st, clk := storetest.New(t)
	alice := storetest.SeedUser(t, st, "alice")
	bob := storetest.SeedUser(t, st, "bob")
	v := store.Vault{ID: ids.New(), OwnerID: alice.ID, EncName: []byte("enc-name")}
	keys := []store.VaultKey{{Epoch: 1, SealedKey: []byte("k1")}, {Epoch: 0, SealedKey: []byte("k0")}}
	if err := st.CreateVault(ctx, v, keys); err != nil {
		t.Fatal(err)
	}
	if err := st.CreateVault(ctx, v, keys); !errors.Is(err, store.ErrExists) {
		t.Fatalf("duplicate vault err = %v", err)
	}

	got, err := st.VaultForMember(ctx, v.ID, alice.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.OwnerID != alice.ID || string(got.EncName) != "enc-name" || got.Seq != 0 || got.CurrentEpoch != 1 || got.CreatedAtMs != clk.Now().UnixMilli() {
		t.Fatalf("got %+v", got)
	}
	if _, err := st.VaultForMember(ctx, v.ID, bob.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("non-member err = %v", err)
	}

	list, err := st.ListVaults(ctx, alice.ID)
	if err != nil || len(list) != 1 || list[0].ID != v.ID {
		t.Fatalf("list = %+v, err %v", list, err)
	}
	if list, _ := st.ListVaults(ctx, bob.ID); len(list) != 0 {
		t.Fatalf("bob sees %+v", list)
	}

	gotKeys, err := st.VaultKeys(ctx, v.ID, alice.ID)
	if err != nil || len(gotKeys) != 2 || gotKeys[0].Epoch != 0 || string(gotKeys[1].SealedKey) != "k1" {
		t.Fatalf("keys = %+v, err %v", gotKeys, err)
	}
	if used, err := st.UsageBytes(ctx, alice.ID); err != nil || used != 0 {
		t.Fatalf("usage = %d, err %v", used, err)
	}
}

func TestCreateVaultRejectsDuplicateEpoch(t *testing.T) {
	st, _ := storetest.New(t)
	alice := storetest.SeedUser(t, st, "alice")
	v := store.Vault{ID: ids.New(), OwnerID: alice.ID, EncName: []byte("n")}
	keys := []store.VaultKey{{Epoch: 0, SealedKey: []byte("k0")}, {Epoch: 1, SealedKey: []byte("a")}, {Epoch: 1, SealedKey: []byte("b")}}
	if err := st.CreateVault(ctx, v, keys); !errors.Is(err, store.ErrInvalid) {
		t.Fatalf("err = %v, want ErrInvalid", err)
	}
	if _, err := st.VaultForMember(ctx, v.ID, alice.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("rejected vault was stored: err = %v", err)
	}
}

func TestVaultKeysForNonMember(t *testing.T) {
	st, _ := storetest.New(t)
	alice := storetest.SeedUser(t, st, "alice")
	bob := storetest.SeedUser(t, st, "bob")
	v := storetest.SeedVault(t, st, alice.ID)
	if _, err := st.VaultKeys(ctx, v.ID, bob.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("non-member err = %v, want ErrNotFound", err)
	}
	if _, err := st.VaultKeys(ctx, ids.New(), alice.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown vault err = %v, want ErrNotFound", err)
	}
	// A member without any sealed keys gets an empty list, not ErrNotFound.
	empty := store.Vault{ID: ids.New(), OwnerID: alice.ID, EncName: []byte("n")}
	if err := st.CreateVault(ctx, empty, nil); err != nil {
		t.Fatal(err)
	}
	if keys, err := st.VaultKeys(ctx, empty.ID, alice.ID); err != nil || len(keys) != 0 {
		t.Fatalf("keys = %+v, err = %v, want none", keys, err)
	}
}
