package store_test

import (
	"bytes"
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
)

func TestTOTPLifecycle(t *testing.T) {
	st, _ := storetest.New(t)
	u := storetest.SeedUser(t, st, "alice")
	got, err := st.TOTP(ctx, u.ID)
	if err != nil || got.Secret != nil || got.PendingSecret != nil || got.LastStep != 0 || got.RecoveryLeft != 0 {
		t.Fatalf("new user = %+v, err %v; want TOTP off", got, err)
	}
	if _, err := st.TOTP(ctx, ids.New()); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown user err = %v", err)
	}
	// Nothing to use while TOTP is off.
	if ok, _ := st.UseTOTPStep(ctx, u.ID, 5); ok {
		t.Fatal("a step was accepted with TOTP off")
	}

	codes := [][]byte{[]byte("h1"), []byte("h2"), []byte("h3")}
	if err := st.EnableTOTP(ctx, u.ID, []byte("secret"), 100, codes); err != nil {
		t.Fatal(err)
	}
	got, _ = st.TOTP(ctx, u.ID)
	if !bytes.Equal(got.Secret, []byte("secret")) || got.LastStep != 100 || got.RecoveryLeft != 3 {
		t.Fatalf("enabled = %+v", got)
	}

	for _, tc := range []struct {
		step int64
		ok   bool
	}{{100, false}, {99, false}, {101, true}, {101, false}, {103, true}} {
		if ok, err := st.UseTOTPStep(ctx, u.ID, tc.step); err != nil || ok != tc.ok {
			t.Fatalf("step %d: ok=%v err=%v, want %v", tc.step, ok, err, tc.ok)
		}
	}
	if ok, _ := st.UseRecoveryCode(ctx, u.ID, []byte("h2")); !ok {
		t.Fatal("unused recovery code refused")
	}
	if ok, _ := st.UseRecoveryCode(ctx, u.ID, []byte("h2")); ok {
		t.Fatal("recovery code used twice")
	}
	if ok, _ := st.UseRecoveryCode(ctx, u.ID, []byte("nope")); ok {
		t.Fatal("unknown recovery code accepted")
	}
	other := storetest.SeedUser(t, st, "bob")
	if ok, _ := st.UseRecoveryCode(ctx, other.ID, []byte("h1")); ok {
		t.Fatal("alice's recovery code worked for bob")
	}
	if got, _ := st.TOTP(ctx, u.ID); got.RecoveryLeft != 2 {
		t.Fatalf("recovery left = %d, want 2", got.RecoveryLeft)
	}

	if err := st.DisableTOTP(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	got, _ = st.TOTP(ctx, u.ID)
	if got.Secret != nil || got.LastStep != 0 || got.RecoveryLeft != 0 {
		t.Fatalf("after disable = %+v", got)
	}
	if ok, _ := st.UseRecoveryCode(ctx, u.ID, []byte("h1")); ok {
		t.Fatal("a recovery code worked with TOTP off")
	}
	if err := st.DisableTOTP(ctx, ids.New()); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("disable unknown user err = %v", err)
	}
}

func TestDeleteUserRemovesRecoveryCodes(t *testing.T) {
	st, _ := storetest.New(t)
	u := storetest.SeedUser(t, st, "alice")
	if err := st.EnableTOTP(ctx, u.ID, []byte("secret"), 1, [][]byte{[]byte("h1")}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.DeleteUser(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	if n := store.CountRows(t, st, "totp_recovery_codes"); n != 0 {
		t.Fatalf("%d recovery codes left after deleting the user", n)
	}
}

// The TOTP migration applies to a 0.1.x database with accounts in it, and a
// 0.1.x binary (which knows only migration 1) still starts on the result.
func TestTOTPMigrationOnAnOldDatabase(t *testing.T) {
	url := "file:" + filepath.Join(t.TempDir(), "meta.db")
	old, err := store.Open(context.Background(), store.Options{URL: url})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.MigrateUpTo(ctx, old, 1); err != nil {
		t.Fatal(err)
	}
	if store.HasTable(t, old, "totp_recovery_codes") {
		t.Fatal("setup: migration 2 already applied")
	}
	u := storetest.SeedUser(t, old, "alice")
	old.Close()

	st, err := store.Open(context.Background(), store.Options{URL: url})
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if got, err := st.TOTP(ctx, u.ID); err != nil || got.Secret != nil {
		t.Fatalf("existing user after migration = %+v, err %v; want TOTP off", got, err)
	}
	if _, err := st.UserByUsername(ctx, "alice"); err != nil {
		t.Fatal(err)
	}
	// An older binary migrating again skips the version it does not know.
	if err := store.MigrateUpTo(ctx, st, 1); err != nil {
		t.Fatalf("0.1.x migrate on the new schema: %v", err)
	}
	storetest.SeedUser(t, st, "bob") // its INSERT still works
}

func TestTOTPEnrolment(t *testing.T) {
	st, _ := storetest.New(t)
	u := storetest.SeedUser(t, st, "alice")
	if ok, err := st.SetPendingTOTP(ctx, u.ID, []byte("first")); !ok || err != nil {
		t.Fatalf("begin: %v %v", ok, err)
	}
	if ok, _ := st.SetPendingTOTP(ctx, u.ID, []byte("second")); !ok {
		t.Fatal("a second begin did not replace the first")
	}
	got, _ := st.TOTP(ctx, u.ID)
	if !bytes.Equal(got.PendingSecret, []byte("second")) || got.Secret != nil {
		t.Fatalf("pending = %+v", got)
	}
	// Confirming the replaced secret does nothing.
	if ok, _ := st.ConfirmTOTP(ctx, u.ID, []byte("first"), 7, [][]byte{[]byte("x")}); ok {
		t.Fatal("a replaced pending secret was confirmed")
	}
	if ok, err := st.ConfirmTOTP(ctx, u.ID, []byte("second"), 7, [][]byte{[]byte("h1"), []byte("h2")}); !ok || err != nil {
		t.Fatalf("confirm: %v %v", ok, err)
	}
	got, _ = st.TOTP(ctx, u.ID)
	if !bytes.Equal(got.Secret, []byte("second")) || got.PendingSecret != nil || got.LastStep != 7 || got.RecoveryLeft != 2 {
		t.Fatalf("after confirm = %+v", got)
	}
	// While on, begin and confirm change nothing.
	if ok, _ := st.SetPendingTOTP(ctx, u.ID, []byte("third")); ok {
		t.Fatal("begin accepted while TOTP is on")
	}
	if ok, _ := st.ConfirmTOTP(ctx, u.ID, []byte("second"), 9, nil); ok {
		t.Fatal("confirm accepted while TOTP is on")
	}
	if ok, err := st.ReplaceRecoveryCodes(ctx, u.ID, [][]byte{[]byte("n1")}); !ok || err != nil {
		t.Fatalf("replace codes: %v %v", ok, err)
	}
	if ok, _ := st.UseRecoveryCode(ctx, u.ID, []byte("h1")); ok {
		t.Fatal("an old recovery code survived the replacement")
	}
	if ok, _ := st.UseRecoveryCode(ctx, u.ID, []byte("n1")); !ok {
		t.Fatal("the new recovery code was refused")
	}
	_ = st.DisableTOTP(ctx, u.ID)
	if ok, _ := st.ReplaceRecoveryCodes(ctx, u.ID, [][]byte{[]byte("n2")}); ok {
		t.Fatal("recovery codes replaced with TOTP off")
	}
}
