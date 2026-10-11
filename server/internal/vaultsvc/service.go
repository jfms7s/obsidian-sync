// Package vaultsvc owns the rules for vaults and the users' key bundles:
// what a new vault must carry, who may read a vault's sealed keys, and when
// a key bundle may be stored or replaced. The HTTP handlers only decode,
// call it and encode.
package vaultsvc

import (
	"bytes"
	"context"
	"errors"
	"fmt"

	"google.golang.org/protobuf/proto"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

const (
	maxEncNameBytes    = 1024
	maxSealedKeyBytes  = 1024
	maxWrappedKeyBytes = 4096

	// Argon2 parameter bounds for a key bundle. The floor keeps a client
	// from storing parameters too weak to protect the wrapped keys; the
	// ceilings matter because every device runs whatever is stored, so an
	// absurd value would lock the user out of all of them.
	MinArgon2MemoryKib   = 8192    // 8 MiB
	MaxArgon2MemoryKib   = 4 << 20 // 4 GiB
	MaxArgon2Iterations  = 64
	MaxArgon2Parallelism = 16
)

type Store interface {
	KeyBundle(ctx context.Context, userID string) (store.KeyBundle, error)
	PutKeyBundle(ctx context.Context, userID string, kb store.KeyBundle) error
	CreateVault(ctx context.Context, v store.Vault, keys []store.VaultKey) error
	ListVaults(ctx context.Context, userID string) ([]store.Vault, error)
	VaultForMember(ctx context.Context, vaultID, userID string) (store.Vault, error)
	VaultKeys(ctx context.Context, vaultID, userID string) ([]store.VaultKey, error)
}

// PasswordVerifier checks a user's account password (auth.Service).
type PasswordVerifier interface {
	VerifyUserPassword(ctx context.Context, userID, password string) error
}

type Service struct {
	st Store
	pw PasswordVerifier
}

func New(st Store, pw PasswordVerifier) *Service { return &Service{st: st, pw: pw} }

var errNoKeyBundle = apperr.New(apperr.NotFound, "no key bundle has been uploaded yet")

// unmarshalOpts reads a stored bundle as the API reads requests: unknown
// fields are dropped.
var unmarshalOpts = proto.UnmarshalOptions{DiscardUnknown: true}

// KeyBundle returns the user's stored key bundle, or NOT_FOUND before the
// first upload.
func (s *Service) KeyBundle(ctx context.Context, userID string) (*obsyncv1.KeyBundle, error) {
	kb, err := s.st.KeyBundle(ctx, userID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, errNoKeyBundle
	}
	if err != nil {
		return nil, err
	}
	var bundle obsyncv1.KeyBundle
	if err := unmarshalOpts.Unmarshal(kb.Bundle, &bundle); err != nil {
		return nil, fmt.Errorf("decode stored key bundle: %w", err)
	}
	return &bundle, nil
}

// PutKeyBundle stores the user's first key bundle, or replaces it (a
// passphrase change). The first upload needs only the device token; a
// replacement also needs the account password in req.CurrentPassword, so a
// stolen token cannot overwrite the wrapped private keys or their KDF
// parameters and break recovery. Resending exactly the stored bundle changes
// nothing and succeeds without the password. Public keys never change.
func (s *Service) PutKeyBundle(ctx context.Context, userID string, req *obsyncv1.KeyBundle) error {
	if err := validateKeyBundle(req); err != nil {
		return err
	}
	// Store only the validated fields, never whatever else came in (and
	// never the password).
	p := req.GetPassParams()
	kb := &obsyncv1.KeyBundle{
		PublicEncKey:  req.PublicEncKey,
		PublicSignKey: req.PublicSignKey,
		PassSalt:      req.PassSalt,
		PassParams: &obsyncv1.Argon2Params{
			MemoryKib: p.MemoryKib, Iterations: p.Iterations, Parallelism: p.Parallelism,
		},
		PassWrapped:     req.PassWrapped,
		RecoveryWrapped: req.RecoveryWrapped,
	}
	data, err := proto.Marshal(kb)
	if err != nil {
		return err
	}
	// A password sent with a first upload is ignored. Two first uploads
	// racing past this check are settled by the store: the later one must
	// carry the very public keys the earlier one just stored, which no one
	// else knows before they are uploaded.
	existing, err := s.st.KeyBundle(ctx, userID)
	switch {
	case errors.Is(err, store.ErrNotFound):
	case err != nil:
		return err
	case sameKeyBundle(existing, kb, data):
		// A retry of an upload that already landed (its response lost):
		// it would change nothing, so it needs no password, and any
		// password sent is not checked (and spends no attempt).
		return nil
	default:
		if err := s.pw.VerifyUserPassword(ctx, userID, req.CurrentPassword); err != nil {
			if errors.Is(err, auth.ErrPasswordRequired) {
				err = apperr.New(apperr.WrongPassword, "replacing the key bundle requires the account password in current_password")
			}
			return err
		}
	}
	err = s.st.PutKeyBundle(ctx, userID, store.KeyBundle{
		PublicEncKey: kb.PublicEncKey, PublicSignKey: kb.PublicSignKey, Bundle: data,
	})
	if errors.Is(err, store.ErrKeyMismatch) {
		return apperr.New(apperr.Invalid, "public keys cannot be changed")
	}
	return err
}

// sameKeyBundle reports whether the stored bundle equals the validated
// incoming one, data being its encoding, in every stored field: the public
// key columns byte for byte, and the stored encoding either byte for byte or,
// should an encoder change make the bytes differ, field for field.
func sameKeyBundle(stored store.KeyBundle, kb *obsyncv1.KeyBundle, data []byte) bool {
	if !bytes.Equal(stored.PublicEncKey, kb.PublicEncKey) || !bytes.Equal(stored.PublicSignKey, kb.PublicSignKey) {
		return false
	}
	if bytes.Equal(stored.Bundle, data) {
		return true
	}
	var old obsyncv1.KeyBundle
	if err := unmarshalOpts.Unmarshal(stored.Bundle, &old); err != nil {
		return false
	}
	return proto.Equal(&old, kb)
}

func validateKeyBundle(kb *obsyncv1.KeyBundle) error {
	p := kb.GetPassParams()
	switch {
	case len(kb.PublicEncKey) != 32:
		return apperr.New(apperr.Invalid, "public_enc_key must be 32 bytes")
	case len(kb.PublicSignKey) != 32:
		return apperr.New(apperr.Invalid, "public_sign_key must be 32 bytes")
	case len(kb.PassSalt) < 16 || len(kb.PassSalt) > 64:
		return apperr.New(apperr.Invalid, "pass_salt must be 16 to 64 bytes")
	case p == nil || p.MemoryKib < MinArgon2MemoryKib || p.Iterations < 1 || p.Parallelism < 1:
		return apperr.New(apperr.Invalid, "pass_params are missing or weaker than %d KiB / 1 iteration", MinArgon2MemoryKib)
	case p.MemoryKib > MaxArgon2MemoryKib || p.Iterations > MaxArgon2Iterations || p.Parallelism > MaxArgon2Parallelism:
		return apperr.New(apperr.Invalid, "pass_params exceed %d KiB / %d iterations / %d lanes",
			MaxArgon2MemoryKib, MaxArgon2Iterations, MaxArgon2Parallelism)
	case len(kb.PassWrapped) == 0 || len(kb.PassWrapped) > maxWrappedKeyBytes:
		return apperr.New(apperr.Invalid, "pass_wrapped must be 1 to %d bytes", maxWrappedKeyBytes)
	case len(kb.RecoveryWrapped) == 0 || len(kb.RecoveryWrapped) > maxWrappedKeyBytes:
		return apperr.New(apperr.Invalid, "recovery_wrapped must be 1 to %d bytes", maxWrappedKeyBytes)
	}
	return nil
}

func (s *Service) ListVaults(ctx context.Context, userID string) ([]store.Vault, error) {
	return s.st.ListVaults(ctx, userID)
}

// NewVault is a vault creation request: the client-chosen id, the encrypted
// name and the vault keys sealed to the creator.
type NewVault struct {
	ID      string
	EncName []byte
	Keys    []store.VaultKey
}

// CreateVault creates a vault owned by userID and returns it as its owner
// sees it.
func (s *Service) CreateVault(ctx context.Context, userID string, nv NewVault) (store.Vault, error) {
	if err := validateNewVault(nv); err != nil {
		return store.Vault{}, err
	}
	err := s.st.CreateVault(ctx, store.Vault{ID: nv.ID, OwnerID: userID, EncName: nv.EncName}, nv.Keys)
	if errors.Is(err, store.ErrExists) {
		return store.Vault{}, apperr.New(apperr.Invalid, "vault id already exists")
	}
	if err != nil {
		return store.Vault{}, err
	}
	return s.st.VaultForMember(ctx, nv.ID, userID)
}

// validateNewVault requires exactly the naming key (epoch 0) and the first
// content key (epoch 1), both sealed to the creator.
func validateNewVault(nv NewVault) error {
	if !ids.Valid(nv.ID) {
		return apperr.New(apperr.Invalid, "vault_id must be 32 lowercase hex characters")
	}
	if len(nv.EncName) == 0 || len(nv.EncName) > maxEncNameBytes {
		return apperr.New(apperr.Invalid, "enc_name must be 1 to %d bytes", maxEncNameBytes)
	}
	seen := map[int]bool{}
	for _, k := range nv.Keys {
		if k.Epoch < 0 || k.Epoch > 1 {
			return apperr.New(apperr.Invalid, "a new vault has only epochs 0 (naming key) and 1")
		}
		if seen[k.Epoch] {
			return apperr.New(apperr.Invalid, "epoch %d appears twice", k.Epoch)
		}
		if len(k.SealedKey) == 0 || len(k.SealedKey) > maxSealedKeyBytes {
			return apperr.New(apperr.Invalid, "sealed keys must be 1 to %d bytes", maxSealedKeyBytes)
		}
		seen[k.Epoch] = true
	}
	if !seen[0] || !seen[1] {
		return apperr.New(apperr.Invalid, "keys for epochs 0 and 1 are required")
	}
	return nil
}

// Action is what a caller wants to do with a vault.
type Action int

const (
	ActionRead Action = iota
	ActionWrite
)

// Authorize is the one access check for a vault: it returns the vault if
// userID may do action on it. A malformed id, an unknown vault and a vault
// userID is not a member of all answer VAULT_NOT_FOUND, so a vault's
// existence never leaks to outsiders. Today every member may read and
// write; roles will tell the actions apart here and nowhere else.
func (s *Service) Authorize(ctx context.Context, userID, vaultID string, action Action) (store.Vault, error) {
	_ = action // every member may do everything until roles exist
	if !ids.Valid(vaultID) {
		return store.Vault{}, apperr.ErrVaultNotFound
	}
	v, err := s.st.VaultForMember(ctx, vaultID, userID)
	if errors.Is(err, store.ErrNotFound) {
		return store.Vault{}, apperr.ErrVaultNotFound
	}
	if err != nil {
		return store.Vault{}, fmt.Errorf("load vault: %w", err)
	}
	return v, nil
}

// VaultKeys returns the vault's keys sealed to userID, after Authorize.
func (s *Service) VaultKeys(ctx context.Context, userID, vaultID string) ([]store.VaultKey, error) {
	if _, err := s.Authorize(ctx, userID, vaultID, ActionRead); err != nil {
		return nil, err
	}
	// The query is scoped to the caller's membership too: a membership
	// removed since Authorize answers not found.
	keys, err := s.st.VaultKeys(ctx, vaultID, userID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, apperr.ErrVaultNotFound
	}
	return keys, err
}
