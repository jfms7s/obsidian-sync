package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"

	"golang.org/x/crypto/argon2"
	"google.golang.org/protobuf/proto"

	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
)

// Labels from plan 2's "Crypto and encoding specification". They are
// written out again here, not shared with the TypeScript code, so the
// vectors check the plugin against an independent reading of the spec.
const (
	labelContentKey   = "obsync/v1/content-key"
	labelMetaKey      = "obsync/v1/meta-key"
	labelChunkIDKey   = "obsync/v1/chunk-id-key"
	labelVaultNameKey = "obsync/v1/vault-name-key"
	labelChunkAAD     = "obsync/v1/chunk"
	labelMetaAAD      = "obsync/v1/meta"
	labelVaultNameAAD = "obsync/v1/vault-name"
	labelSealInfo     = "obsync/v1/seal"
	labelSealAAD      = "obsync/v1/sealed-key"
	labelRecoveryKEK  = "obsync/v1/recovery-kek"
	labelPassAAD      = "obsync/v1/keys-pass"
	labelRecoveryAAD  = "obsync/v1/keys-recovery"
	labelSealSig      = "obsync/v1/sealed-key-sig"
	labelVaultNameSig = "obsync/v1/vault-name-sig"
)

// det returns n deterministic bytes for name: SHA-256("obsync-vector/" ‖
// name ‖ u32be(i)) for i = 0, 1, … concatenated. Every "random" input in
// the vectors comes from here, so regenerating gives identical files.
func det(name string, n int) []byte {
	var out []byte
	for i := uint32(0); len(out) < n; i++ {
		h := sha256.New()
		h.Write([]byte("obsync-vector/" + name))
		_ = binary.Write(h, binary.BigEndian, i)
		out = h.Sum(out)
	}
	return out[:n]
}

func hx(b []byte) string { return hex.EncodeToString(b) }

func u32be(n uint32) []byte { return binary.BigEndian.AppendUint32(nil, n) }

func cat(parts ...[]byte) []byte { return bytes.Join(parts, nil) }

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

func idBytes(hexID string) []byte {
	b := must(hex.DecodeString(hexID))
	if len(b) != 16 {
		panic("ids are 16 bytes")
	}
	return b
}

func hkdf32(ikm, salt []byte, info []byte) []byte {
	return must(hkdf.Key(sha256.New, ikm, salt, string(info), 32))
}

func hmac256(key, msg []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(msg)
	return m.Sum(nil)
}

// seal is AES-256-GCM returning nonce ‖ ciphertext ‖ tag.
func seal(key, nonce, plaintext, aad []byte) []byte {
	gcm := must(cipher.NewGCM(must(aes.NewCipher(key))))
	return gcm.Seal(append([]byte(nil), nonce...), nonce, plaintext, aad)
}

// pad is the length-hiding encoding: u32be(len(msg)) ‖ msg ‖ zeros, in all
// max(128, the next power of two ≥ 4 + len(msg)) bytes.
func pad(msg []byte) []byte {
	size := 128
	for size < 4+len(msg) {
		size *= 2
	}
	out := make([]byte, size)
	binary.BigEndian.PutUint32(out, uint32(len(msg)))
	copy(out[4:], msg)
	return out
}

func epochSubkey(label string, vaultID string, epoch uint32, epochKey []byte) []byte {
	return hkdf32(epochKey, idBytes(vaultID), cat([]byte(label), u32be(epoch)))
}

// ---------- vector files ----------

type epochKeyCase struct {
	VaultID      string `json:"vault_id"`
	Epoch        uint32 `json:"epoch"`
	EpochKey     string `json:"epoch_key"`
	ContentKey   string `json:"content_key"`
	MetaKey      string `json:"meta_key"`
	ChunkIDKey   string `json:"chunk_id_key"`
	VaultNameKey string `json:"vault_name_key"`
}

func epochKeys() any {
	var cases []epochKeyCase
	for _, c := range []struct {
		vault string
		epoch uint32
	}{{"0123456789abcdef0123456789abcdef", 1}, {"fedcba9876543210fedcba9876543210", 2}, {"00000000000000000000000000000001", 4294967295}} {
		k := det(fmt.Sprintf("epoch-key/%s/%d", c.vault, c.epoch), 32)
		cases = append(cases, epochKeyCase{
			VaultID: c.vault, Epoch: c.epoch, EpochKey: hx(k),
			ContentKey:   hx(epochSubkey(labelContentKey, c.vault, c.epoch, k)),
			MetaKey:      hx(epochSubkey(labelMetaKey, c.vault, c.epoch, k)),
			ChunkIDKey:   hx(epochSubkey(labelChunkIDKey, c.vault, c.epoch, k)),
			VaultNameKey: hx(epochSubkey(labelVaultNameKey, c.vault, c.epoch, k)),
		})
	}
	return map[string]any{"cases": cases}
}

type fileIDCase struct {
	Input  string `json:"input"` // as a device might report it
	Path   string `json:"path"`  // normalized: NFC, '/' separators
	FileID string `json:"file_id"`
}

func fileIDs() any {
	namingKey := det("naming-key", 32)
	var cases []fileIDCase
	for _, c := range []struct{ input, path string }{
		{"Welcome.md", "Welcome.md"},
		{"Notes/2026/Daily note.md", "Notes/2026/Daily note.md"},
		{"Café.md", "Café.md"}, // NFD input, NFC path
		{"Café.md", "Café.md"},
		{"Folder\\Sub\\x.md", "Folder/Sub/x.md"},
		{"日本語/ノート.md", "日本語/ノート.md"},
		{"Attachments/image (1).png", "Attachments/image (1).png"},
	} {
		cases = append(cases, fileIDCase{Input: c.input, Path: c.path, FileID: hx(hmac256(namingKey, []byte(c.path)))})
	}
	return map[string]any{"naming_key": hx(namingKey), "cases": cases}
}

type chunkCase struct {
	Plaintext string `json:"plaintext"`
	ChunkID   string `json:"chunk_id"`
	Nonce     string `json:"nonce"`
	AAD       string `json:"aad"`
	Sealed    string `json:"sealed"`
}

func chunks() any {
	const vault = "0123456789abcdef0123456789abcdef"
	const epoch = 1
	k := det(fmt.Sprintf("epoch-key/%s/%d", vault, epoch), 32)
	contentKey := epochSubkey(labelContentKey, vault, epoch, k)
	chunkIDKey := epochSubkey(labelChunkIDKey, vault, epoch, k)
	var cases []chunkCase
	for i, pt := range [][]byte{
		[]byte("x"),
		[]byte("# Hello\n\nThis is a note.\n"),
		det("chunk-binary", 1000),
	} {
		id := hmac256(chunkIDKey, pt)
		nonce := det(fmt.Sprintf("chunk-nonce/%d", i), 12)
		aad := cat([]byte(labelChunkAAD), idBytes(vault), u32be(epoch), id)
		cases = append(cases, chunkCase{Plaintext: hx(pt), ChunkID: hx(id), Nonce: hx(nonce), AAD: hx(aad), Sealed: hx(seal(contentKey, nonce, pt, aad))})
	}
	return map[string]any{"vault_id": vault, "epoch": epoch, "epoch_key": hx(k), "cases": cases}
}

type metaJSON struct {
	Path        string `json:"path"`
	MtimeMs     int64  `json:"mtime_ms"`
	Size        uint64 `json:"size"`
	ContentHash string `json:"content_hash"`
	RenamedFrom string `json:"renamed_from"`
	DeviceName  string `json:"device_name"`
}

type metaCase struct {
	Content   *string  `json:"content"` // the file's plaintext; null for a deletion
	Meta      metaJSON `json:"meta"`
	FileID    string   `json:"file_id"`
	VersionID string   `json:"version_id"`
	Plaintext string   `json:"plaintext"` // the FileMeta protobuf encoding
	Padded    string   `json:"padded"`    // pad(plaintext), what is encrypted
	Nonce     string   `json:"nonce"`
	AAD       string   `json:"aad"`
	EncMeta   string   `json:"enc_meta"`
}

func metas() any {
	const vault = "0123456789abcdef0123456789abcdef"
	const epoch = 1
	k := det(fmt.Sprintf("epoch-key/%s/%d", vault, epoch), 32)
	metaKey := epochSubkey(labelMetaKey, vault, epoch, k)
	namingKey := det("naming-key", 32)
	str := func(s string) *string { return &s }
	var cases []metaCase
	for i, c := range []struct {
		content       *string
		path, renamed string
		mtime         int64
		device        string
	}{
		{str("# Hello\n"), "Welcome.md", "", 1767225600123, "Laptop"},
		{str(""), "Empty.md", "", 1767225600000, "Phone"},
		{str("moved\n"), "Archive/Old idea.md", "Inbox/Old idea.md", 1767312000999, "Tablet (iPad)"},
		{nil, "Deleted.md", "", 1767398400000, "Laptop"},
		{str("deep\n"), "Projects/2026/A rather long folder name for testing/Another level/Meeting notes from the quarterly planning session.md", "", 1767398400001, "Laptop"},
	} {
		m := &obsyncv1.FileMeta{Path: c.path, MtimeMs: c.mtime, RenamedFrom: c.renamed, DeviceName: c.device}
		if c.content != nil {
			sum := sha256.Sum256([]byte(*c.content))
			m.Size = uint64(len(*c.content))
			m.ContentHash = sum[:]
		}
		pt := must(proto.MarshalOptions{Deterministic: true}.Marshal(m))
		fileID := hmac256(namingKey, []byte(c.path))
		versionID := det(fmt.Sprintf("version-id/%d", i), 16)
		nonce := det(fmt.Sprintf("meta-nonce/%d", i), 12)
		aad := cat([]byte(labelMetaAAD), idBytes(vault), u32be(epoch), fileID, versionID)
		cases = append(cases, metaCase{
			Content: c.content,
			Meta: metaJSON{Path: m.Path, MtimeMs: m.MtimeMs, Size: m.Size, ContentHash: hx(m.ContentHash),
				RenamedFrom: m.RenamedFrom, DeviceName: m.DeviceName},
			FileID: hx(fileID), VersionID: hx(versionID), Plaintext: hx(pt), Padded: hx(pad(pt)), Nonce: hx(nonce), AAD: hx(aad),
			EncMeta: hx(seal(metaKey, nonce, pad(pt), aad)),
		})
	}
	return map[string]any{"vault_id": vault, "epoch": epoch, "epoch_key": hx(k), "naming_key": hx(namingKey), "cases": cases}
}

type vaultNameCase struct {
	Input      string `json:"input"`
	Name       string `json:"name"` // NFC
	Nonce      string `json:"nonce"`
	AAD        string `json:"aad"`
	SigMessage string `json:"sig_message"`
	EncName    string `json:"enc_name"`
}

func vaultNames() any {
	const vault = "fedcba9876543210fedcba9876543210"
	const epoch = 1
	k := det(fmt.Sprintf("epoch-key/%s/%d", vault, epoch), 32)
	nameKey := epochSubkey(labelVaultNameKey, vault, epoch, k)
	signer := ed25519.NewKeyFromSeed(det("name-signer", 32))
	var cases []vaultNameCase
	for i, c := range []struct{ input, name string }{{"Personal", "Personal"}, {"Résumés", "Résumés"}} {
		nonce := det(fmt.Sprintf("name-nonce/%d", i), 12)
		aad := cat([]byte(labelVaultNameAAD), idBytes(vault), u32be(epoch))
		core := cat(u32be(epoch), seal(nameKey, nonce, pad([]byte(c.name)), aad))
		msg := cat([]byte(labelVaultNameSig), idBytes(vault), u32be(epoch), core)
		cases = append(cases, vaultNameCase{Input: c.input, Name: c.name, Nonce: hx(nonce), AAD: hx(aad), SigMessage: hx(msg),
			EncName: hx(cat(core, ed25519.Sign(signer, msg)))})
	}
	return map[string]any{"vault_id": vault, "epoch": epoch, "epoch_key": hx(k),
		"signer_seed": hx(signer.Seed()), "signer_pub": hx(signer.Public().(ed25519.PublicKey)), "cases": cases}
}

type sealCase struct {
	VaultID       string `json:"vault_id"`
	Epoch         uint32 `json:"epoch"`
	UserID        string `json:"user_id"`
	RecipientPriv string `json:"recipient_priv"`
	RecipientPub  string `json:"recipient_pub"`
	EphemeralPriv string `json:"ephemeral_priv"`
	EphemeralPub  string `json:"ephemeral_pub"`
	Shared        string `json:"shared"`
	KEK           string `json:"kek"`
	Key           string `json:"key"`
	Nonce         string `json:"nonce"`
	AAD           string `json:"aad"`
	SealerSeed    string `json:"sealer_seed"`
	SealerPub     string `json:"sealer_pub"`
	SigMessage    string `json:"sig_message"`
	Sealed        string `json:"sealed"`
}

func sealedKeys() any {
	var cases []sealCase
	for i, c := range []struct {
		vault, user string
		epoch       uint32
	}{{"0123456789abcdef0123456789abcdef", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 0}, {"0123456789abcdef0123456789abcdef", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1}} {
		rcpt := must(ecdh.X25519().NewPrivateKey(det("recipient", 32)))
		eph := must(ecdh.X25519().NewPrivateKey(det(fmt.Sprintf("ephemeral/%d", i), 32)))
		shared := must(eph.ECDH(rcpt.PublicKey()))
		ephPub, rcptPub := eph.PublicKey().Bytes(), rcpt.PublicKey().Bytes()
		kek := hkdf32(shared, nil, cat([]byte(labelSealInfo), ephPub, rcptPub))
		key := det(fmt.Sprintf("vault-key/%d", c.epoch), 32)
		nonce := det(fmt.Sprintf("seal-nonce/%d", i), 12)
		aad := cat([]byte(labelSealAAD), idBytes(c.vault), u32be(c.epoch), idBytes(c.user))
		sealer := ed25519.NewKeyFromSeed(det("sealer", 32))
		core := cat(ephPub, seal(kek, nonce, key, aad))
		msg := cat([]byte(labelSealSig), idBytes(c.vault), u32be(c.epoch), idBytes(c.user), core)
		cases = append(cases, sealCase{
			VaultID: c.vault, Epoch: c.epoch, UserID: c.user,
			RecipientPriv: hx(rcpt.Bytes()), RecipientPub: hx(rcptPub), EphemeralPriv: hx(eph.Bytes()), EphemeralPub: hx(ephPub),
			Shared: hx(shared), KEK: hx(kek), Key: hx(key), Nonce: hx(nonce), AAD: hx(aad),
			SealerSeed: hx(sealer.Seed()), SealerPub: hx(sealer.Public().(ed25519.PublicKey)), SigMessage: hx(msg),
			Sealed: hx(cat(core, ed25519.Sign(sealer, msg))),
		})
	}
	return map[string]any{"cases": cases}
}

// BIP39 reference vectors (github.com/trezor/python-mnemonic vectors.json),
// 256-bit entropy, English word list.
var bip39Vectors = []struct{ entropy, words string }{
	{"0000000000000000000000000000000000000000000000000000000000000000",
		"abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art"},
	{"7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f",
		"legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title"},
	{"8080808080808080808080808080808080808080808080808080808080808080",
		"letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic bless"},
	{"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		"zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote"},
}

type argon2JSON struct {
	MemoryKib   uint32 `json:"memory_kib"`
	Iterations  uint32 `json:"iterations"`
	Parallelism uint32 `json:"parallelism"`
}

type userKeyCase struct {
	UserID          string     `json:"user_id"`
	EncPriv         string     `json:"enc_priv"`
	EncPub          string     `json:"enc_pub"`
	SignSeed        string     `json:"sign_seed"`
	SignPub         string     `json:"sign_pub"`
	PassphraseInput string     `json:"passphrase_input"`
	Passphrase      string     `json:"passphrase"` // NFC
	PassSalt        string     `json:"pass_salt"`
	PassParams      argon2JSON `json:"pass_params"`
	PassKEK         string     `json:"pass_kek"`
	PassNonce       string     `json:"pass_nonce"`
	PassAAD         string     `json:"pass_aad"`
	PassWrapped     string     `json:"pass_wrapped"`
	RecoveryKey     string     `json:"recovery_key"`
	RecoveryWords   string     `json:"recovery_words"`
	RecoveryKEK     string     `json:"recovery_kek"`
	RecoveryNonce   string     `json:"recovery_nonce"`
	RecoveryAAD     string     `json:"recovery_aad"`
	RecoveryWrapped string     `json:"recovery_wrapped"`
}

func userKeys() any {
	var cases []userKeyCase
	for i, c := range []struct {
		user, input, pass string
		params            argon2JSON
		bip               int
	}{
		{"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "correct horse battery staple", "correct horse battery staple", argon2JSON{8192, 1, 1}, 1},
		{"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "pásse-partout", "pásse-partout", argon2JSON{19456, 2, 1}, 2},
	} {
		encPriv := must(ecdh.X25519().NewPrivateKey(det(fmt.Sprintf("user-enc/%d", i), 32)))
		seed := det(fmt.Sprintf("user-sign/%d", i), 32)
		signPub := ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)
		encPub := encPriv.PublicKey().Bytes()
		plaintext := cat(encPriv.Bytes(), seed)

		salt := det(fmt.Sprintf("pass-salt/%d", i), 16)
		passKEK := argon2.IDKey([]byte(c.pass), salt, c.params.Iterations, c.params.MemoryKib, uint8(c.params.Parallelism), 32)
		passNonce := det(fmt.Sprintf("pass-nonce/%d", i), 12)
		passAAD := cat([]byte(labelPassAAD), idBytes(c.user), encPub, signPub,
			[]byte{byte(len(salt))}, salt, u32be(c.params.MemoryKib), u32be(c.params.Iterations), u32be(c.params.Parallelism))

		recoveryKey := must(hex.DecodeString(bip39Vectors[c.bip].entropy))
		recoveryKEK := hkdf32(recoveryKey, nil, cat([]byte(labelRecoveryKEK), idBytes(c.user)))
		recNonce := det(fmt.Sprintf("recovery-nonce/%d", i), 12)
		recAAD := cat([]byte(labelRecoveryAAD), idBytes(c.user), encPub, signPub)

		cases = append(cases, userKeyCase{
			UserID: c.user, EncPriv: hx(encPriv.Bytes()), EncPub: hx(encPub), SignSeed: hx(seed), SignPub: hx(signPub),
			PassphraseInput: c.input, Passphrase: c.pass, PassSalt: hx(salt), PassParams: c.params, PassKEK: hx(passKEK),
			PassNonce: hx(passNonce), PassAAD: hx(passAAD), PassWrapped: hx(seal(passKEK, passNonce, plaintext, passAAD)),
			RecoveryKey: hx(recoveryKey), RecoveryWords: bip39Vectors[c.bip].words, RecoveryKEK: hx(recoveryKEK),
			RecoveryNonce: hx(recNonce), RecoveryAAD: hx(recAAD), RecoveryWrapped: hx(seal(recoveryKEK, recNonce, plaintext, recAAD)),
		})
	}
	return map[string]any{"cases": cases}
}

func bip39() any {
	type c struct {
		Entropy string `json:"entropy"`
		Words   string `json:"words"`
	}
	var cases []c
	for _, v := range bip39Vectors {
		cases = append(cases, c{v.entropy, v.words})
	}
	return map[string]any{"cases": cases}
}

// files maps each vector file name to its generator.
type paddingCase struct {
	Length int `json:"length"`
	Padded int `json:"padded_length"`
}

func padding() any {
	var cases []paddingCase
	for _, n := range []int{0, 1, 124, 125, 252, 253, 1000, 5000} {
		cases = append(cases, paddingCase{n, len(pad(make([]byte, n)))})
	}
	return map[string]any{"cases": cases}
}

var files = []struct {
	name string
	gen  func() any
}{
	{"epoch-keys.json", epochKeys},
	{"file-ids.json", fileIDs},
	{"chunks.json", chunks},
	{"meta.json", metas},
	{"vault-names.json", vaultNames},
	{"sealed-keys.json", sealedKeys},
	{"user-keys.json", userKeys},
	{"bip39.json", bip39},
	{"padding.json", padding},
	{"rejects.json", rejects},
}

// render returns every vector file's exact contents.
func render() map[string][]byte {
	out := map[string][]byte{}
	for _, f := range files {
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		enc.SetIndent("", "  ")
		if err := enc.Encode(map[string]any{
			"generated_by": "server/cmd/vectorgen (do not edit; run make vectors)",
			"vectors":      f.gen(),
		}); err != nil {
			panic(err)
		}
		out[f.name] = buf.Bytes()
	}
	return out
}
