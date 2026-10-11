package auth

import (
	"context"
	"fmt"
	"strings"

	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

// maxCodeBytes bounds a submitted code before any work is done on it.
const maxCodeBytes = 64

// checkSecondFactor checks code, a TOTP code or a recovery code, for the
// account whose TOTP state is st, and spends it: a TOTP step or a recovery
// code is accepted once. It reports false for a wrong, replayed or used
// code.
func (s *Service) checkSecondFactor(ctx context.Context, userID string, st store.TOTPState, code string) (bool, error) {
	if len(code) > maxCodeBytes || st.Secret == nil {
		return false, nil
	}
	if digits := strings.ReplaceAll(code, " ", ""); isTOTPCode(digits) {
		step, ok := VerifyTOTP(st.Secret, digits, s.now(), st.LastStep)
		if !ok {
			return false, nil
		}
		// Recorded atomically: of two logins racing with one code, one wins.
		used, err := s.st.UseTOTPStep(ctx, userID, st.Secret, step)
		if err != nil {
			return false, fmt.Errorf("record totp step: %w", err)
		}
		return used, nil
	}
	norm, ok := NormalizeRecoveryCode(code)
	if !ok {
		return false, nil
	}
	used, err := s.st.UseRecoveryCode(ctx, userID, RecoveryCodeHash(norm))
	if err != nil {
		return false, fmt.Errorf("use recovery code: %w", err)
	}
	return used, nil
}
