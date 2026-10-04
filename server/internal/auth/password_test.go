package auth_test

import (
	"strings"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/auth"
)

func TestHashAndVerifyPassword(t *testing.T) {
	h1, err := auth.HashPassword("correct horse", auth.FastParams)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h1, "$argon2id$v=19$m=1024,t=1,p=1$") {
		t.Fatalf("encoding = %q", h1)
	}
	h2, _ := auth.HashPassword("correct horse", auth.FastParams)
	if h1 == h2 {
		t.Fatal("hashes must be salted")
	}
	if ok, err := auth.VerifyPassword("correct horse", h1); err != nil || !ok {
		t.Fatalf("verify ok=%v err=%v", ok, err)
	}
	if ok, _ := auth.VerifyPassword("wrong", h1); ok {
		t.Fatal("wrong password verified")
	}
	if _, err := auth.VerifyPassword("x", "$bcrypt$nope"); err == nil {
		t.Fatal("malformed hash must be an error")
	}
}

func TestToken(t *testing.T) {
	tok, hash, err := auth.NewToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(tok) != 43 {
		t.Fatalf("token length = %d", len(tok))
	}
	if string(auth.HashToken(tok)) != string(hash) {
		t.Fatal("HashToken does not match the returned hash")
	}
	tok2, _, _ := auth.NewToken()
	if tok == tok2 {
		t.Fatal("tokens repeat")
	}
}
