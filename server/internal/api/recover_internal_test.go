package api

import (
	"bytes"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRecovererDoesNotWriteTwice(t *testing.T) {
	var logs bytes.Buffer
	h := &handlers{log: slog.New(slog.NewTextHandler(&logs, nil))}
	rec := httptest.NewRecorder()
	func() {
		defer func() {
			if p := recover(); p != http.ErrAbortHandler {
				t.Errorf("recovered %v, want http.ErrAbortHandler", p)
			}
		}()
		h.recoverer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte("partial"))
			panic("boom")
		})).ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	}()
	if rec.Code != http.StatusAccepted || rec.Body.String() != "partial" {
		t.Fatalf("got %d %q, want the original partial response only", rec.Code, rec.Body.String())
	}
	if !strings.Contains(logs.String(), "handler panic") {
		t.Errorf("panic not logged: %s", logs.String())
	}
}

func TestRecovererWritesErrorBeforeHeaders(t *testing.T) {
	h := &handlers{log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	rec := httptest.NewRecorder()
	h.recoverer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("boom")
	})).ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != http.StatusInternalServerError || rec.Header().Get("Content-Type") != protoContentType {
		t.Fatalf("got %d %q", rec.Code, rec.Header().Get("Content-Type"))
	}
}
