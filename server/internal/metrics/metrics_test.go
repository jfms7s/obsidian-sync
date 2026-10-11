package metrics_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/metrics"
)

func scrape(t *testing.T, r *metrics.Registry) string {
	t.Helper()
	var b strings.Builder
	if err := r.Write(context.Background(), &b); err != nil {
		t.Fatal(err)
	}
	return b.String()
}

func TestExpositionIsExactAndSorted(t *testing.T) {
	r := metrics.NewRegistry()
	commits := r.NewCounterVec("test_commits_total", "Commits by result.", "result", "ok", "conflict")
	up := r.NewCounter("test_uploads_total", "Chunks stored.")
	g := r.NewGauge("test_connections", "Open sockets.")
	r.NewGaugeFunc("test_answer", "A computed gauge.", func() float64 { return 4.5 })
	r.NewInfo("test_build_info", "Build information.", "version", `1.0 "quoted"\n`)

	commits.With("ok").Add(3)
	commits.With("conflict").Inc()
	up.Inc()
	g.Set(2)
	g.Add(-1)

	want := `# HELP test_answer A computed gauge.
# TYPE test_answer gauge
test_answer 4.5
# HELP test_build_info Build information.
# TYPE test_build_info gauge
test_build_info{version="1.0 \"quoted\"\\n"} 1
# HELP test_commits_total Commits by result.
# TYPE test_commits_total counter
test_commits_total{result="conflict"} 1
test_commits_total{result="ok"} 3
# HELP test_connections Open sockets.
# TYPE test_connections gauge
test_connections 1
# HELP test_uploads_total Chunks stored.
# TYPE test_uploads_total counter
test_uploads_total 1
`
	if got := scrape(t, r); got != want {
		t.Fatalf("exposition:\n%s\nwant:\n%s", got, want)
	}
}

func TestUnknownLabelValuePanics(t *testing.T) {
	r := metrics.NewRegistry()
	v := r.NewCounterVec("x_total", "x", "result", "ok")
	defer func() {
		if recover() == nil {
			t.Fatal("an undeclared label value was accepted")
		}
	}()
	v.With("surprise")
}

func TestDuplicateNamePanics(t *testing.T) {
	r := metrics.NewRegistry()
	r.NewCounter("x_total", "x")
	defer func() {
		if recover() == nil {
			t.Fatal("a second metric with the same name was accepted")
		}
	}()
	r.NewGauge("x_total", "x")
}

func TestNilMetricsAreNoOps(t *testing.T) {
	var c *metrics.Counter
	c.Inc()
	c.Add(2)
	var g *metrics.Gauge
	g.Set(1)
	g.Add(1)
	var v *metrics.CounterVec
	v.With("anything").Inc()
}

func TestScrapeGroupOmittedOnError(t *testing.T) {
	r := metrics.NewRegistry()
	errs := r.NewCounter("test_scrape_errors_total", "Failed scrape-time collections.")
	fail := false
	r.NewScrapeGauges(func(context.Context) ([]float64, error) {
		if fail {
			return nil, errors.New("database down")
		}
		return []float64{2, 7}, nil
	}, errs, metrics.Desc{Name: "test_users", Help: "Accounts."}, metrics.Desc{Name: "test_vaults", Help: "Vaults."})

	got := scrape(t, r)
	if !strings.Contains(got, "\ntest_users 2\n") || !strings.Contains(got, "\ntest_vaults 7\n") || !strings.Contains(got, "test_scrape_errors_total 0\n") {
		t.Fatalf("exposition:\n%s", got)
	}
	fail = true
	got = scrape(t, r)
	if strings.Contains(got, "test_users") || strings.Contains(got, "test_vaults") || !strings.Contains(got, "test_scrape_errors_total 1\n") {
		t.Fatalf("exposition after a failed collection:\n%s", got)
	}
}

func TestHandler(t *testing.T) {
	r := metrics.NewRegistry()
	r.NewCounter("x_total", "x").Inc()
	srv := httptest.NewServer(r.Handler())
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/plain; version=0.0.4") {
		t.Fatalf("GET /metrics = %d %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	for _, tc := range []struct{ method, path string }{{"GET", "/"}, {"GET", "/metrics/x"}, {"POST", "/metrics"}} {
		req, _ := http.NewRequest(tc.method, srv.URL+tc.path, nil)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode == 200 {
			t.Errorf("%s %s = 200, want only GET /metrics served", tc.method, tc.path)
		}
	}
}
