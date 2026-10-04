package apperr_test

import (
	"errors"
	"fmt"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
)

func TestCodeOf(t *testing.T) {
	wrapped := fmt.Errorf("context: %w", apperr.New(apperr.NotFound, "vault %s not found", "x"))
	if apperr.CodeOf(wrapped) != apperr.NotFound {
		t.Fatalf("code = %v", apperr.CodeOf(wrapped))
	}
	if apperr.CodeOf(errors.New("boom")) != apperr.Internal {
		t.Fatal("plain errors must map to INTERNAL")
	}
	if got := apperr.New(apperr.Invalid, "bad %d", 3).Error(); got != "bad 3" {
		t.Fatalf("message = %q", got)
	}
}
