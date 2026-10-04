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

func TestVerifyPasswordRejectsMalformedHashes(t *testing.T) {
	salt := "c2FsdHNhbHRzYWx0c2FsdA"                     // 16 bytes
	key := "a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2U" // 32 bytes
	b64 := func(n int) string { return strings.Repeat("A", (n*4+2)/3) }
	good := "$argon2id$v=19$m=1024,t=1,p=1$" + salt + "$" + key
	if _, err := auth.VerifyPassword("x", good); err != nil {
		t.Fatalf("baseline hash rejected: %v", err)
	}
	for name, h := range map[string]string{
		"t=0":            "$argon2id$v=19$m=1024,t=0,p=1$" + salt + "$" + key,
		"p=0":            "$argon2id$v=19$m=1024,t=1,p=0$" + salt + "$" + key,
		"t too big":      "$argon2id$v=19$m=1024,t=11,p=1$" + salt + "$" + key,
		"p too big":      "$argon2id$v=19$m=1024,t=1,p=17$" + salt + "$" + key,
		"p overflows":    "$argon2id$v=19$m=1024,t=1,p=257$" + salt + "$" + key,
		"m too big":      "$argon2id$v=19$m=1048577,t=1,p=1$" + salt + "$" + key,
		"m huge":         "$argon2id$v=19$m=4294967295,t=1,p=1$" + salt + "$" + key,
		"m below 8p":     "$argon2id$v=19$m=15,t=1,p=2$" + salt + "$" + key,
		"negative m":     "$argon2id$v=19$m=-1,t=1,p=1$" + salt + "$" + key,
		"plus sign":      "$argon2id$v=19$m=+1024,t=1,p=1$" + salt + "$" + key,
		"trailing junk":  "$argon2id$v=19$m=1024,t=1,p=1junk$" + salt + "$" + key,
		"extra param":    "$argon2id$v=19$m=1024,t=1,p=1,x=2$" + salt + "$" + key,
		"reordered":      "$argon2id$v=19$t=1,m=1024,p=1$" + salt + "$" + key,
		"space":          "$argon2id$v=19$m=1024, t=1,p=1$" + salt + "$" + key,
		"version junk":   "$argon2id$v=19x$m=1024,t=1,p=1$" + salt + "$" + key,
		"wrong version":  "$argon2id$v=16$m=1024,t=1,p=1$" + salt + "$" + key,
		"empty salt":     "$argon2id$v=19$m=1024,t=1,p=1$$" + key,
		"short salt":     "$argon2id$v=19$m=1024,t=1,p=1$" + b64(7) + "$" + key,
		"long salt":      "$argon2id$v=19$m=1024,t=1,p=1$" + b64(65) + "$" + key,
		"short key":      "$argon2id$v=19$m=1024,t=1,p=1$" + salt + "$" + b64(15),
		"long key":       "$argon2id$v=19$m=1024,t=1,p=1$" + salt + "$" + b64(65),
		"newline in b64": "$argon2id$v=19$m=1024,t=1,p=1$" + salt[:4] + "\n" + salt[4:] + "$" + key,
		"padded b64":     "$argon2id$v=19$m=1024,t=1,p=1$" + salt + "==$" + key,
		"argon2i":        "$argon2i$v=19$m=1024,t=1,p=1$" + salt + "$" + key,
		"too few parts":  "$argon2id$v=19$m=1024,t=1,p=1$" + salt,
	} {
		t.Run(name, func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("panic: %v", r)
				}
			}()
			if ok, err := auth.VerifyPassword("x", h); err == nil || ok {
				t.Fatalf("ok=%v err=%v, want an error", ok, err)
			}
		})
	}
}

func TestHashPasswordRejectsUnverifiableParams(t *testing.T) {
	for name, p := range map[string]auth.Params{
		"zero":       {},
		"short salt": {Memory: 1024, Iterations: 1, Parallelism: 1, SaltLen: 4, KeyLen: 32},
		"huge m":     {Memory: 1 << 21, Iterations: 1, Parallelism: 1, SaltLen: 16, KeyLen: 32},
	} {
		t.Run(name, func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("panic: %v", r)
				}
			}()
			if _, err := auth.HashPassword("x", p); err == nil {
				t.Fatal("no error")
			}
		})
	}
	if _, err := auth.HashPassword("x", auth.DefaultParams); err != nil {
		t.Fatalf("DefaultParams rejected: %v", err)
	}
}
