package vaultsvc_test

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
	"github.com/jfms7s/obsidian-sync/server/internal/vaultsvc"
)

var ctx = context.Background()

// passwords is a PasswordVerifier that accepts "right" and counts checks.
type passwords struct{ checks int }

func (p *passwords) VerifyUserPassword(_ context.Context, _ string, password string) error {
	switch password {
	case "":
		return auth.ErrPasswordRequired
	case "right":
		p.checks++
		return nil
	default:
		p.checks++
		return auth.ErrWrongPassword
	}
}

type fixture struct {
	svc  *vaultsvc.Service
	st   *store.Store
	pw   *passwords
	user store.User
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	st, _ := storetest.New(t)
	pw := &passwords{}
	return fixture{svc: vaultsvc.New(st, pw), st: st, pw: pw, user: storetest.SeedUser(t, st, "alice")}
}

func bundle(fill byte) *obsyncv1.KeyBundle {
	return &obsyncv1.KeyBundle{
		PublicEncKey:    bytes.Repeat([]byte{fill}, 32),
		PublicSignKey:   bytes.Repeat([]byte{fill + 1}, 32),
		PassSalt:        bytes.Repeat([]byte{3}, 16),
		PassParams:      &obsyncv1.Argon2Params{MemoryKib: 65536, Iterations: 3, Parallelism: 1},
		PassWrapped:     []byte("pass-wrapped"),
		RecoveryWrapped: []byte("recovery-wrapped"),
	}
}

func TestKeyBundleRules(t *testing.T) {
	f := newFixture(t)
	if _, err := f.svc.KeyBundle(ctx, f.user.ID); apperr.CodeOf(err) != apperr.NotFound {
		t.Fatalf("before upload err = %v, want NOT_FOUND", err)
	}

	// The first upload needs only the token.
	first := bundle(1)
	if err := f.svc.PutKeyBundle(ctx, f.user.ID, first); err != nil {
		t.Fatalf("first upload: %v", err)
	}
	got, err := f.svc.KeyBundle(ctx, f.user.ID)
	if err != nil || !bytes.Equal(got.PassWrapped, first.PassWrapped) || got.CurrentPassword != "" {
		t.Fatalf("stored = %v, err %v", got, err)
	}

	// Resending exactly the stored bundle needs no password and checks none.
	if err := f.svc.PutKeyBundle(ctx, f.user.ID, bundle(1)); err != nil || f.pw.checks != 0 {
		t.Fatalf("identical retry: err %v, %d password checks", err, f.pw.checks)
	}
	retry := bundle(1)
	retry.CurrentPassword = "wrong"
	if err := f.svc.PutKeyBundle(ctx, f.user.ID, retry); err != nil || f.pw.checks != 0 {
		t.Fatalf("identical retry with a password: err %v, %d password checks", err, f.pw.checks)
	}

	// A replacement needs the account password.
	changed := bundle(1)
	changed.PassWrapped = []byte("new passphrase")
	if err := f.svc.PutKeyBundle(ctx, f.user.ID, changed); apperr.CodeOf(err) != apperr.WrongPassword {
		t.Fatalf("replacement without password: err = %v, want WRONG_PASSWORD", err)
	}
	changed.CurrentPassword = "wrong"
	if err := f.svc.PutKeyBundle(ctx, f.user.ID, changed); apperr.CodeOf(err) != apperr.WrongPassword {
		t.Fatalf("replacement with a wrong password: err = %v", err)
	}
	changed.CurrentPassword = "right"
	if err := f.svc.PutKeyBundle(ctx, f.user.ID, changed); err != nil {
		t.Fatalf("replacement with the password: %v", err)
	}
	if got, _ := f.svc.KeyBundle(ctx, f.user.ID); !bytes.Equal(got.PassWrapped, []byte("new passphrase")) || got.CurrentPassword != "" {
		t.Fatalf("replacement not stored, or the password was: %v", got)
	}

	// Public keys never change, even with the password.
	other := bundle(7)
	other.CurrentPassword = "right"
	if err := f.svc.PutKeyBundle(ctx, f.user.ID, other); apperr.CodeOf(err) != apperr.Invalid {
		t.Fatalf("new public keys: err = %v, want INVALID", err)
	}
}

func TestKeyBundleValidation(t *testing.T) {
	f := newFixture(t)
	for name, mutate := range map[string]func(*obsyncv1.KeyBundle){
		"short enc key":       func(b *obsyncv1.KeyBundle) { b.PublicEncKey = b.PublicEncKey[:31] },
		"short sign key":      func(b *obsyncv1.KeyBundle) { b.PublicSignKey = nil },
		"short salt":          func(b *obsyncv1.KeyBundle) { b.PassSalt = b.PassSalt[:15] },
		"long salt":           func(b *obsyncv1.KeyBundle) { b.PassSalt = make([]byte, 65) },
		"no params":           func(b *obsyncv1.KeyBundle) { b.PassParams = nil },
		"memory below floor":  func(b *obsyncv1.KeyBundle) { b.PassParams.MemoryKib = vaultsvc.MinArgon2MemoryKib - 1 },
		"memory above cap":    func(b *obsyncv1.KeyBundle) { b.PassParams.MemoryKib = vaultsvc.MaxArgon2MemoryKib + 1 },
		"no iterations":       func(b *obsyncv1.KeyBundle) { b.PassParams.Iterations = 0 },
		"too many iterations": func(b *obsyncv1.KeyBundle) { b.PassParams.Iterations = vaultsvc.MaxArgon2Iterations + 1 },
		"no lanes":            func(b *obsyncv1.KeyBundle) { b.PassParams.Parallelism = 0 },
		"too many lanes":      func(b *obsyncv1.KeyBundle) { b.PassParams.Parallelism = vaultsvc.MaxArgon2Parallelism + 1 },
		"no pass wrap":        func(b *obsyncv1.KeyBundle) { b.PassWrapped = nil },
		"huge recovery wrap":  func(b *obsyncv1.KeyBundle) { b.RecoveryWrapped = make([]byte, 4097) },
	} {
		b := bundle(1)
		mutate(b)
		if err := f.svc.PutKeyBundle(ctx, f.user.ID, b); apperr.CodeOf(err) != apperr.Invalid {
			t.Errorf("%s: err = %v, want INVALID", name, err)
		}
	}
	edge := bundle(1)
	edge.PassParams = &obsyncv1.Argon2Params{MemoryKib: vaultsvc.MinArgon2MemoryKib, Iterations: 1, Parallelism: 1}
	if err := f.svc.PutKeyBundle(ctx, f.user.ID, edge); err != nil {
		t.Fatalf("the floor itself is allowed: %v", err)
	}
}

func newVault(id string) vaultsvc.NewVault {
	return vaultsvc.NewVault{ID: id, EncName: []byte("name"), Keys: []store.VaultKey{
		{Epoch: 0, SealedKey: []byte("naming")}, {Epoch: 1, SealedKey: []byte("content")},
	}}
}

func TestCreateVault(t *testing.T) {
	f := newFixture(t)
	id := ids.New()
	v, err := f.svc.CreateVault(ctx, f.user.ID, newVault(id))
	if err != nil || v.ID != id || v.OwnerID != f.user.ID || v.CurrentEpoch != 1 {
		t.Fatalf("vault = %+v, err %v", v, err)
	}
	if _, err := f.svc.CreateVault(ctx, f.user.ID, newVault(id)); apperr.CodeOf(err) != apperr.Invalid {
		t.Fatalf("duplicate id: err = %v, want INVALID", err)
	}
	list, err := f.svc.ListVaults(ctx, f.user.ID)
	if err != nil || len(list) != 1 || list[0].ID != id {
		t.Fatalf("list = %+v, err %v", list, err)
	}

	// A new vault has exactly the naming key (epoch 0) and the first content key (epoch 1).
	for name, mutate := range map[string]func(*vaultsvc.NewVault){
		"bad id":         func(n *vaultsvc.NewVault) { n.ID = "not-hex" },
		"no name":        func(n *vaultsvc.NewVault) { n.EncName = nil },
		"huge name":      func(n *vaultsvc.NewVault) { n.EncName = make([]byte, 1025) },
		"no epoch 0":     func(n *vaultsvc.NewVault) { n.Keys = n.Keys[1:] },
		"no epoch 1":     func(n *vaultsvc.NewVault) { n.Keys = n.Keys[:1] },
		"epoch 2":        func(n *vaultsvc.NewVault) { n.Keys = append(n.Keys, store.VaultKey{Epoch: 2, SealedKey: []byte("k")}) },
		"epoch twice":    func(n *vaultsvc.NewVault) { n.Keys = append(n.Keys, n.Keys[0]) },
		"empty sealed":   func(n *vaultsvc.NewVault) { n.Keys[0].SealedKey = nil },
		"huge sealed":    func(n *vaultsvc.NewVault) { n.Keys[1].SealedKey = make([]byte, 1025) },
		"negative epoch": func(n *vaultsvc.NewVault) { n.Keys[0].Epoch = -1 },
	} {
		nv := newVault(ids.New())
		mutate(&nv)
		if _, err := f.svc.CreateVault(ctx, f.user.ID, nv); apperr.CodeOf(err) != apperr.Invalid {
			t.Errorf("%s: err = %v, want INVALID", name, err)
		}
	}
}

func TestVaultKeysAreForMembersOnly(t *testing.T) {
	f := newFixture(t)
	id := ids.New()
	if _, err := f.svc.CreateVault(ctx, f.user.ID, newVault(id)); err != nil {
		t.Fatal(err)
	}
	keys, err := f.svc.VaultKeys(ctx, f.user.ID, id)
	if err != nil || len(keys) != 2 {
		t.Fatalf("keys = %+v, err %v", keys, err)
	}
	bob := storetest.SeedUser(t, f.st, "bob")
	for name, vaultID := range map[string]string{"non-member": id, "unknown vault": ids.New(), "malformed id": "<script>"} {
		_, err := f.svc.VaultKeys(ctx, bob.ID, vaultID)
		if !errors.Is(err, apperr.ErrVaultNotFound) {
			t.Errorf("%s: err = %v, want ErrVaultNotFound", name, err)
		}
	}
}
