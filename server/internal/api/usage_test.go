package api_test

import (
	"bytes"
	"net/http"
	"strings"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
)

// putSizedChunk uploads a chunk of n bytes, filled with fill, to vault.
func (e *testEnv) putSizedChunk(token, vault string, fill byte, n int) {
	e.t.Helper()
	e.putChunk(token, vault, bytes.Repeat([]byte{fill}, 32), strings.Repeat(string(rune(fill)), n))
}

func TestAccountUsage(t *testing.T) {
	e := newTestEnv(t)
	alice := e.createUser("alice", "correct horse")
	bob := e.createUser("bob", "battery staple")
	aliceTok, _ := e.login("alice", "correct horse")
	bobTok, _ := e.login("bob", "battery staple")

	notes := e.createVault(aliceTok)
	work := e.createVault(aliceTok)
	e.putSizedChunk(aliceTok, notes, 0x01, 100)
	e.putSizedChunk(aliceTok, notes, 0x02, 50)
	e.putSizedChunk(aliceTok, work, 0x03, 7)
	bobs := e.createVault(bobTok)
	e.putSizedChunk(bobTok, bobs, 0x04, 1000)

	var got obsyncv1.GetUsageResponse
	if status, apiErr := e.do("GET", "/v1/account/usage", aliceTok, nil, &got); status != http.StatusOK {
		t.Fatalf("usage = %d %v", status, apiErr)
	}
	want, err := e.st.UsageBytes(ctx, alice.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.UsedBytes != want || got.UsedBytes != 157 {
		t.Errorf("used_bytes = %d, want %d (Store.UsageBytes) = 157", got.UsedBytes, want)
	}
	if got.QuotaBytes != alice.QuotaBytes {
		t.Errorf("quota_bytes = %d, want %d", got.QuotaBytes, alice.QuotaBytes)
	}
	perVault := map[string]int64{}
	for _, v := range got.Vaults {
		perVault[v.VaultId] = v.UsedBytes
	}
	if len(got.Vaults) != 2 || perVault[notes] != 150 || perVault[work] != 7 {
		t.Errorf("vaults = %v, want %s=150 and %s=7 only", got.Vaults, notes, work)
	}

	// Bob sees only his own vault, and alice's bytes are not his.
	if status, apiErr := e.do("GET", "/v1/account/usage", bobTok, nil, &got); status != http.StatusOK {
		t.Fatalf("usage = %d %v", status, apiErr)
	}
	if got.UsedBytes != 1000 || got.QuotaBytes != bob.QuotaBytes || len(got.Vaults) != 1 || got.Vaults[0].VaultId != bobs {
		t.Errorf("bob's usage = %v", &got)
	}
}

func TestAccountUsageEmpty(t *testing.T) {
	e := newTestEnv(t)
	alice := e.createUser("alice", "correct horse")
	token, _ := e.login("alice", "correct horse")
	var got obsyncv1.GetUsageResponse
	if status, apiErr := e.do("GET", "/v1/account/usage", token, nil, &got); status != http.StatusOK {
		t.Fatalf("usage = %d %v", status, apiErr)
	}
	if got.UsedBytes != 0 || got.QuotaBytes != alice.QuotaBytes || len(got.Vaults) != 0 {
		t.Errorf("usage = %v", &got)
	}
}

func TestAccountUsageNeedsToken(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	status, apiErr := e.do("GET", "/v1/account/usage", "", nil, nil)
	wantErr(t, status, apiErr, 401, apperr.Unauthorized)
	status, apiErr = e.do("GET", "/v1/account/usage", "made-up", nil, nil)
	wantErr(t, status, apiErr, 401, apperr.Unauthorized)
}
