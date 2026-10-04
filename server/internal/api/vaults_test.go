package api_test

import (
	"bytes"
	"encoding/hex"
	"io"
	"net/http"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
)

func (e *testEnv) createVault(token string) string {
	e.t.Helper()
	id := ids.New()
	var v obsyncv1.Vault
	status, apiErr := e.do("POST", "/v1/vaults", token, &obsyncv1.CreateVaultRequest{
		VaultId: id,
		EncName: []byte("encrypted name"),
		Keys:    []*obsyncv1.VaultKey{{Epoch: 0, SealedKey: []byte("naming")}, {Epoch: 1, SealedKey: []byte("epoch1")}},
	}, &v)
	if status != http.StatusCreated {
		e.t.Fatalf("create vault: %d %v", status, apiErr)
	}
	return id
}

func TestVaultLifecycle(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	token, _ := e.login("alice", "correct horse")
	id := e.createVault(token)

	var list obsyncv1.ListVaultsResponse
	e.do("GET", "/v1/vaults", token, nil, &list)
	if len(list.Vaults) != 1 || list.Vaults[0].VaultId != id || list.Vaults[0].CurrentEpoch != 1 || string(list.Vaults[0].EncName) != "encrypted name" {
		t.Fatalf("vaults = %v", list.Vaults)
	}
	var keys obsyncv1.VaultKeysResponse
	e.do("GET", "/v1/vaults/"+id+"/keys", token, nil, &keys)
	if len(keys.Keys) != 2 || keys.Keys[0].Epoch != 0 || string(keys.Keys[1].SealedKey) != "epoch1" {
		t.Fatalf("keys = %v", keys.Keys)
	}
	status, apiErr := e.do("POST", "/v1/vaults", token, &obsyncv1.CreateVaultRequest{
		VaultId: id, EncName: []byte("x"),
		Keys: []*obsyncv1.VaultKey{{Epoch: 0, SealedKey: []byte("a")}, {Epoch: 1, SealedKey: []byte("b")}},
	}, nil)
	wantErr(t, status, apiErr, 400, apperr.Invalid)
}

func TestCreateVaultValidation(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	token, _ := e.login("alice", "correct horse")
	keys := []*obsyncv1.VaultKey{{Epoch: 0, SealedKey: []byte("a")}, {Epoch: 1, SealedKey: []byte("b")}}
	for name, req := range map[string]*obsyncv1.CreateVaultRequest{
		"bad id":        {VaultId: "../x", EncName: []byte("n"), Keys: keys},
		"no name":       {VaultId: ids.New(), Keys: keys},
		"missing epoch": {VaultId: ids.New(), EncName: []byte("n"), Keys: keys[:1]},
		"extra epoch":   {VaultId: ids.New(), EncName: []byte("n"), Keys: append(keys, &obsyncv1.VaultKey{Epoch: 2, SealedKey: []byte("c")})},
	} {
		status, apiErr := e.do("POST", "/v1/vaults", token, req, nil)
		if status != 400 || apiErr.Code != apperr.Invalid {
			t.Errorf("%s: %d %v", name, status, apiErr)
		}
	}
}

func TestSyncFlow(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	token, deviceID := e.login("alice", "correct horse")
	vault := e.createVault(token)
	base := "/v1/vaults/" + vault
	chunkID := bytes.Repeat([]byte{0xab}, 32)
	chunkHex := hex.EncodeToString(chunkID)
	fileID := bytes.Repeat([]byte{0x01}, 32)

	var exists obsyncv1.ChunkExistsResponse
	e.do("POST", base+"/chunks/exists", token, &obsyncv1.ChunkExistsRequest{ChunkIds: [][]byte{chunkID}}, &exists)
	if len(exists.Exists) != 1 || exists.Exists[0] {
		t.Fatalf("exists before upload = %v", exists.Exists)
	}
	if status, body := e.doRaw("PUT", base+"/chunks/"+chunkHex, token, []byte("ciphertext")); status != http.StatusNoContent {
		t.Fatalf("put chunk = %d %q", status, body)
	}
	e.do("POST", base+"/chunks/exists", token, &obsyncv1.ChunkExistsRequest{ChunkIds: [][]byte{chunkID}}, &exists)
	if !exists.Exists[0] {
		t.Fatal("chunk missing after upload")
	}
	if status, body := e.doRaw("GET", base+"/chunks/"+chunkHex, token, nil); status != 200 || string(body) != "ciphertext" {
		t.Fatalf("get chunk = %d %q", status, body)
	}

	v1 := ids.Bytes(16)
	var cr obsyncv1.CommitResponse
	e.do("POST", base+"/commit", token, &obsyncv1.CommitRequest{Commits: []*obsyncv1.Commit{{
		FileId: fileID, VersionId: v1, Epoch: 1, EncMeta: []byte("meta"), ChunkIds: [][]byte{chunkID}, Size: 10,
	}}}, &cr)
	if len(cr.Results) != 1 || !cr.Results[0].Ok || cr.Results[0].Seq != 1 || cr.VaultSeq != 1 {
		t.Fatalf("commit = %v", &cr)
	}

	var changes obsyncv1.ChangesResponse
	e.do("GET", base+"/changes?since=0", token, nil, &changes)
	if len(changes.Versions) != 1 || changes.More || changes.VaultSeq != 1 {
		t.Fatalf("changes = %v", &changes)
	}
	got := changes.Versions[0]
	if !bytes.Equal(got.VersionId, v1) || got.DeviceId != deviceID || len(got.ChunkIds) != 1 || got.Size != 10 || got.Seq != 1 {
		t.Fatalf("version = %v", got)
	}

	var heads obsyncv1.HeadsResponse
	e.do("GET", base+"/heads", token, nil, &heads)
	if len(heads.Heads) != 1 || !bytes.Equal(heads.Heads[0].VersionId, v1) {
		t.Fatalf("heads = %v", heads.Heads)
	}

	// A second device that never saw v1 also creates the file: conflict.
	e.do("POST", base+"/commit", token, &obsyncv1.CommitRequest{Commits: []*obsyncv1.Commit{{
		FileId: fileID, VersionId: ids.Bytes(16), Epoch: 1, EncMeta: []byte("meta"),
	}}}, &cr)
	if cr.Results[0].Ok || cr.Results[0].Error.Code != apperr.Conflict || !bytes.Equal(cr.Results[0].HeadVersionId, v1) {
		t.Fatalf("conflict result = %v", cr.Results[0])
	}

	// Delete, then the file shows in the trash and has two history entries.
	e.do("POST", base+"/commit", token, &obsyncv1.CommitRequest{Commits: []*obsyncv1.Commit{{
		FileId: fileID, VersionId: ids.Bytes(16), BaseVersionId: v1, Epoch: 1, EncMeta: []byte("meta"), Deleted: true,
	}}}, &cr)
	if !cr.Results[0].Ok || cr.Results[0].Seq != 2 {
		t.Fatalf("delete = %v", cr.Results[0])
	}
	var trash obsyncv1.VersionsResponse
	e.do("GET", base+"/trash", token, nil, &trash)
	if len(trash.Versions) != 1 || !trash.Versions[0].Deleted {
		t.Fatalf("trash = %v", trash.Versions)
	}
	var hist obsyncv1.VersionsResponse
	e.do("GET", base+"/files/"+hex.EncodeToString(fileID)+"/history", token, nil, &hist)
	if len(hist.Versions) != 2 || !hist.Versions[0].Deleted {
		t.Fatalf("history = %v", hist.Versions)
	}
}

func TestOtherUsersCannotReachAVault(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	e.createUser("bob", "battery staple")
	alice, _ := e.login("alice", "correct horse")
	bob, _ := e.login("bob", "battery staple")
	vault := e.createVault(alice)
	chunkHex := hex.EncodeToString(bytes.Repeat([]byte{1}, 32))

	for _, path := range []string{"/keys", "/changes", "/heads", "/trash", "/chunks/" + chunkHex} {
		status, apiErr := e.do("GET", "/v1/vaults/"+vault+path, bob, nil, nil)
		if status != 404 || apiErr.Code != apperr.NotFound {
			t.Errorf("GET %s = %d %v", path, status, apiErr)
		}
	}
	if status, _ := e.doRaw("PUT", "/v1/vaults/"+vault+"/chunks/"+chunkHex, bob, []byte("x")); status != 404 {
		t.Errorf("PUT chunk = %d", status)
	}
}

func TestRequestValidation(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	token, _ := e.login("alice", "correct horse")
	vault := e.createVault(token)
	base := "/v1/vaults/" + vault

	if status, _ := e.doRaw("GET", base+"/changes?since=abc", token, nil); status != 400 {
		t.Errorf("bad since = %d", status)
	}
	if status, _ := e.doRaw("GET", base+"/heads?after=zz", token, nil); status != 400 {
		t.Errorf("bad after = %d", status)
	}
	if status, _ := e.doRaw("PUT", base+"/chunks/abc", token, []byte("x")); status != 400 {
		t.Errorf("bad chunk id = %d", status)
	}

	// A streamed body has no Content-Length.
	pr, pw := io.Pipe()
	go func() { pw.Write([]byte("data")); pw.Close() }()
	req, _ := http.NewRequest("PUT", e.url+base+"/chunks/"+hex.EncodeToString(bytes.Repeat([]byte{2}, 32)), pr)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Errorf("chunked upload = %d, want 400", resp.StatusCode)
	}
}
