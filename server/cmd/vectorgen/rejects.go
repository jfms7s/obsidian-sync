package main

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math/big"
	"slices"
	"strings"

	"google.golang.org/protobuf/proto"

	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
)

// Reject vectors: inputs a conforming client must refuse. Each one is
// otherwise well formed (correct keys, AAD and, where there is one, a valid
// signature over the bad content), so only the named check stops it.

// ed25519L is the order of the Ed25519 base point.
var ed25519L, _ = new(big.Int).SetString("7237005577332262213973186563042994240857116359379907606001950938285454250989", 10)

// malleate returns sig with S replaced by S + L: the same point equation
// holds, but RFC 8032 (and Go) require S < L.
func malleate(pub ed25519.PublicKey, msg, sig []byte) []byte {
	le := slices.Clone(sig[32:])
	slices.Reverse(le)
	s := new(big.Int).Add(new(big.Int).SetBytes(le), ed25519L)
	be := s.FillBytes(make([]byte, 32))
	slices.Reverse(be)
	out := cat(sig[:32], be)
	if ed25519.Verify(pub, msg, out) {
		panic("vectorgen: Go accepted a non-canonical S")
	}
	return out
}

// smallOrderPoints are X25519 public keys whose shared secret with any
// private key is all zeros (points of order 1, 2, 4 or 8, and p - 1).
var smallOrderPoints = []string{
	"0000000000000000000000000000000000000000000000000000000000000000",
	"0100000000000000000000000000000000000000000000000000000000000000",
	"e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
	"5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
	"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
}

type rejectSealCase struct {
	Why           string `json:"why"`
	VaultID       string `json:"vault_id"`
	Epoch         uint32 `json:"epoch"`
	UserID        string `json:"user_id"`
	RecipientPriv string `json:"recipient_priv"`
	SealerPub     string `json:"sealer_pub"`
	Sealed        string `json:"sealed"`
}

type rejectMetaCase struct {
	Why       string `json:"why"`
	FileID    string `json:"file_id"`
	VersionID string `json:"version_id"`
	EncMeta   string `json:"enc_meta"`
}

type rejectNameCase struct {
	Why     string `json:"why"`
	EncName string `json:"enc_name"`
}

func rejectSeals() []rejectSealCase {
	const vault, user = "0123456789abcdef0123456789abcdef", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const epoch = 1
	rcpt := must(ecdh.X25519().NewPrivateKey(det("recipient", 32)))
	rcptPub := rcpt.PublicKey().Bytes()
	sealer := ed25519.NewKeyFromSeed(det("sealer", 32))
	sealerPub := sealer.Public().(ed25519.PublicKey)
	key := det("vault-key/1", 32)
	aad := cat([]byte(labelSealAAD), idBytes(vault), u32be(epoch), idBytes(user))
	sign := func(core []byte) ([]byte, []byte) {
		msg := cat([]byte(labelSealSig), idBytes(vault), u32be(epoch), idBytes(user), core)
		return msg, ed25519.Sign(sealer, msg)
	}
	mk := func(why string, sealed []byte) rejectSealCase {
		return rejectSealCase{Why: why, VaultID: vault, Epoch: epoch, UserID: user, RecipientPriv: hx(rcpt.Bytes()),
			SealerPub: hx(sealerPub), Sealed: hx(sealed)}
	}
	var cases []rejectSealCase

	// A valid seal whose signature has S + L.
	eph := must(ecdh.X25519().NewPrivateKey(det("reject-ephemeral", 32)))
	shared := must(eph.ECDH(rcpt.PublicKey()))
	kek := hkdf32(shared, nil, cat([]byte(labelSealInfo), eph.PublicKey().Bytes(), rcptPub))
	core := cat(eph.PublicKey().Bytes(), seal(kek, det("reject-seal-nonce/0", 12), key, aad))
	msg, sig := sign(core)
	cases = append(cases, mk("signature S is not canonical (S + L)", cat(core, malleate(sealerPub, msg, sig))))

	// Signed seals whose ephemeral key has small order: the shared secret
	// is all zeros, so the KEK would be public. Encrypted under that KEK so
	// only the all-zero check rejects them.
	for i, p := range smallOrderPoints {
		ephPub := must(hex.DecodeString(p))
		if pk, err := ecdh.X25519().NewPublicKey(ephPub); err == nil {
			if _, err := rcpt.ECDH(pk); err == nil {
				panic("vectorgen: Go accepted a small-order X25519 point")
			}
		}
		kek := hkdf32(make([]byte, 32), nil, cat([]byte(labelSealInfo), ephPub, rcptPub))
		core := cat(ephPub, seal(kek, det(fmt.Sprintf("reject-seal-nonce/%d", i+1), 12), key, aad))
		_, sig := sign(core)
		cases = append(cases, mk("ephemeral key has small order: "+p, cat(core, sig)))
	}
	return cases
}

func rejectMetas() any {
	const vault = "0123456789abcdef0123456789abcdef"
	const epoch = 1
	k := det(fmt.Sprintf("epoch-key/%s/%d", vault, epoch), 32)
	metaKey := epochSubkey(labelMetaKey, vault, epoch, k)
	namingKey := det("naming-key", 32)
	sum := sha256.Sum256([]byte("x"))
	base := func() *obsyncv1.FileMeta {
		return &obsyncv1.FileMeta{Path: "Notes/x.md", MtimeMs: 1767225600000, Size: 1, ContentHash: sum[:], DeviceName: "Laptop"}
	}
	marshal := func(m *obsyncv1.FileMeta) []byte { return must(proto.MarshalOptions{Deterministic: true}.Marshal(m)) }
	var cases []rejectMetaCase
	for i, c := range []struct {
		why    string
		padded func() []byte
	}{
		{"nonzero padding byte", func() []byte {
			p := pad(marshal(base()))
			p[len(p)-1] = 1
			return p
		}},
		{"padded to a larger bucket than its length needs", func() []byte {
			pt := marshal(base())
			p := make([]byte, 256)
			copy(p, pad(pt)[:4+len(pt)])
			return p
		}},
		{"renamed_from is not a normalized path", func() []byte {
			m := base()
			m.RenamedFrom = "Inbox/../x.md"
			return pad(marshal(m))
		}},
		{"renamed_from is not NFC", func() []byte {
			m := base()
			m.RenamedFrom = "Café.md"
			return pad(marshal(m))
		}},
		{"size exceeds 2^53 - 1", func() []byte {
			m := base()
			m.Size = 1<<53 + 1
			return pad(marshal(m))
		}},
		{"mtime_ms exceeds 2^53 - 1", func() []byte {
			m := base()
			m.MtimeMs = 1<<53 + 1
			return pad(marshal(m))
		}},
		{"mtime_ms is below -(2^53 - 1)", func() []byte {
			m := base()
			m.MtimeMs = -(1<<53 + 1)
			return pad(marshal(m))
		}},
	} {
		fileID := hmac256(namingKey, []byte("Notes/x.md"))
		versionID := det(fmt.Sprintf("reject-version-id/%d", i), 16)
		nonce := det(fmt.Sprintf("reject-meta-nonce/%d", i), 12)
		aad := cat([]byte(labelMetaAAD), idBytes(vault), u32be(epoch), fileID, versionID)
		cases = append(cases, rejectMetaCase{Why: c.why, FileID: hx(fileID), VersionID: hx(versionID),
			EncMeta: hx(seal(metaKey, nonce, c.padded(), aad))})
	}
	return map[string]any{"vault_id": vault, "epoch": epoch, "epoch_key": hx(k), "naming_key": hx(namingKey), "cases": cases}
}

func rejectVaultNames() any {
	const vault = "fedcba9876543210fedcba9876543210"
	const epoch = 1
	k := det(fmt.Sprintf("epoch-key/%s/%d", vault, epoch), 32)
	nameKey := epochSubkey(labelVaultNameKey, vault, epoch, k)
	signer := ed25519.NewKeyFromSeed(det("name-signer", 32))
	signerPub := signer.Public().(ed25519.PublicKey)
	aad := cat([]byte(labelVaultNameAAD), idBytes(vault), u32be(epoch))
	var cases []rejectNameCase
	for i, c := range []struct {
		why       string
		padded    []byte
		malleable bool
	}{
		{"signature S is not canonical (S + L)", pad([]byte("Personal")), true},
		{"empty name", pad(nil), false},
		{"name longer than 200 bytes", pad([]byte(strings.Repeat("a", 201))), false},
		{"name is not NFC", pad([]byte("Résumés")), false},
		{"nonzero padding byte", func() []byte { p := pad([]byte("Personal")); p[len(p)-1] = 1; return p }(), false},
	} {
		core := cat(u32be(epoch), seal(nameKey, det(fmt.Sprintf("reject-name-nonce/%d", i), 12), c.padded, aad))
		msg := cat([]byte(labelVaultNameSig), idBytes(vault), u32be(epoch), core)
		sig := ed25519.Sign(signer, msg)
		if c.malleable {
			sig = malleate(signerPub, msg, sig)
		}
		cases = append(cases, rejectNameCase{Why: c.why, EncName: hx(cat(core, sig))})
	}
	return map[string]any{"vault_id": vault, "epoch": epoch, "epoch_key": hx(k), "signer_pub": hx(signerPub), "cases": cases}
}

func rejects() any {
	return map[string]any{
		"small_order_points": smallOrderPoints,
		"sealed_keys":        rejectSeals(),
		"meta":               rejectMetas(),
		"vault_names":        rejectVaultNames(),
	}
}
