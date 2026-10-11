package admin_test

import (
	"strings"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/admin"
	"github.com/jfms7s/obsidian-sync/server/internal/blob"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
)

func TestUserTOTPStatusAndDisable(t *testing.T) {
	st, _ := storetest.New(t)
	blobs, _ := blob.NewFS(t.TempDir())
	u := storetest.SeedUser(t, st, "alice")

	d, out := deps(t, st, blobs, "")
	if err := admin.Run(ctx, []string{"user", "totp", "status", "--username", "alice"}, d); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "two-step sign-in is off for alice") {
		t.Fatalf("status = %q", out)
	}

	if err := st.EnableTOTP(ctx, u.ID, []byte("secret"), 1, [][]byte{[]byte("a"), []byte("b")}); err != nil {
		t.Fatal(err)
	}
	d, out = deps(t, st, blobs, "")
	if err := admin.Run(ctx, []string{"user", "totp", "status", "--username", "alice"}, d); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "two-step sign-in is on for alice (2 recovery codes left)") {
		t.Fatalf("status = %q", out)
	}
	if strings.Contains(out.String(), "secret") {
		t.Fatalf("status shows the secret: %q", out)
	}

	d, out = deps(t, st, blobs, "")
	if err := admin.Run(ctx, []string{"user", "totp", "disable", "--username", "alice"}, d); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "two-step sign-in turned off for alice") {
		t.Fatalf("disable = %q", out)
	}
	if got, _ := st.TOTP(ctx, u.ID); got.Secret != nil || got.RecoveryLeft != 0 {
		t.Fatalf("after disable = %+v", got)
	}

	for name, args := range map[string][]string{
		"no verb":      {"user", "totp"},
		"unknown verb": {"user", "totp", "enable", "--username", "alice"},
		"no username":  {"user", "totp", "status"},
		"unknown user": {"user", "totp", "disable", "--username", "mallory"},
	} {
		d, _ := deps(t, st, blobs, "")
		if err := admin.Run(ctx, args, d); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
}
