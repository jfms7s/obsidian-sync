package api_test

import (
	"net/http"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
)

var apiTOTPSecret = []byte("12345678901234567890")

func TestLoginSecondFactor(t *testing.T) {
	e := newTestEnv(t)
	u := e.createUser("alice", "correct horse")
	existing, _ := e.login("alice", "correct horse")
	if err := e.st.EnableTOTP(ctx, u.ID, apiTOTPSecret, 0, nil); err != nil {
		t.Fatal(err)
	}
	req := func(password, code string) *obsyncv1.LoginRequest {
		return &obsyncv1.LoginRequest{Username: "alice", Password: password, TotpCode: code, DeviceName: "phone"}
	}

	status, apiErr := e.do("POST", "/v1/auth/login", "", req("correct horse", ""), nil)
	wantErr(t, status, apiErr, http.StatusUnauthorized, apperr.SecondFactorRequired)

	status, wrongCode := e.do("POST", "/v1/auth/login", "", req("correct horse", "000000"), nil)
	wantErr(t, status, wrongCode, http.StatusUnauthorized, apperr.Unauthorized)
	status, wrongPassword := e.do("POST", "/v1/auth/login", "", req("not it", auth.TOTPCode(apiTOTPSecret, auth.TOTPStep(e.clk.Now()))), nil)
	wantErr(t, status, wrongPassword, http.StatusUnauthorized, apperr.Unauthorized)
	if wrongCode.Message != wrongPassword.Message {
		t.Fatalf("a wrong code (%q) and a wrong password (%q) are told apart", wrongCode.Message, wrongPassword.Message)
	}

	var ok obsyncv1.LoginResponse
	code := auth.TOTPCode(apiTOTPSecret, auth.TOTPStep(e.clk.Now()))
	if status, apiErr := e.do("POST", "/v1/auth/login", "", req("correct horse", code), &ok); status != http.StatusOK || ok.Token == "" {
		t.Fatalf("login with the code = %d %v", status, apiErr)
	}
	// The device signed in before TOTP was turned on keeps working.
	if status, apiErr := e.do("GET", "/v1/devices", existing, nil, nil); status != http.StatusOK {
		t.Fatalf("existing token = %d %v", status, apiErr)
	}
}
