// Package metrics is a small Prometheus registry: counters and gauges, a
// label only from a set fixed when the metric is declared (so cardinality is
// bounded by code, and no label can carry a user, vault, device or path), and
// the text exposition format. Every metric method is safe on a nil receiver,
// so code runs unchanged without a registry.
package metrics

import (
	"context"
	"fmt"
	"io"
	"math"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// scrapeTimeout bounds the scrape-time collections (database counts).
const scrapeTimeout = 2 * time.Second

// Counter only goes up.
type Counter struct{ v atomic.Uint64 }

func (c *Counter) Inc() { c.Add(1) }

func (c *Counter) Add(n uint64) {
	if c != nil {
		c.v.Add(n)
	}
}

// Gauge is a value that goes up and down.
type Gauge struct{ bits atomic.Uint64 }

func (g *Gauge) Set(v float64) {
	if g != nil {
		g.bits.Store(math.Float64bits(v))
	}
}

func (g *Gauge) Add(d float64) {
	if g == nil {
		return
	}
	for {
		old := g.bits.Load()
		if g.bits.CompareAndSwap(old, math.Float64bits(math.Float64frombits(old)+d)) {
			return
		}
	}
}

func (g *Gauge) value() float64 { return math.Float64frombits(g.bits.Load()) }

// CounterVec is a counter per value of one label, every value declared up
// front.
type CounterVec struct {
	label    string
	counters map[string]*Counter
}

// With returns the counter for value. A value not declared with the metric
// panics: it is a programming error, and refusing it keeps the label set
// fixed. On a nil CounterVec it returns a nil (no-op) counter.
func (v *CounterVec) With(value string) *Counter {
	if v == nil {
		return nil
	}
	c, ok := v.counters[value]
	if !ok {
		panic(fmt.Sprintf("metrics: label %s=%q was not declared", v.label, value))
	}
	return c
}

// Desc names a gauge filled by a scrape-time collection.
type Desc struct{ Name, Help string }

type kind int

const (
	counterKind kind = iota
	gaugeKind
)

func (k kind) String() string {
	if k == counterKind {
		return "counter"
	}
	return "gauge"
}

// family is one metric name: its samples are produced at scrape time.
type family struct {
	name, help string
	kind       kind
	// samples appends "name{labels} value" lines without the name; ok=false
	// leaves the whole family out of this scrape.
	samples func(s *scrape) (lines []sample, ok bool)
}

type sample struct {
	labels string // `{k="v"}` or empty
	value  string
}

// scrape holds the results of the scrape-time collections for one request.
type scrape struct {
	results map[*scrapeGroup]scrapeResult
}

type scrapeResult struct {
	values []float64
	ok     bool
}

type scrapeGroup struct {
	collect func(context.Context) ([]float64, error)
	errors  *Counter
}

type Registry struct {
	mu       sync.Mutex
	families map[string]*family
	groups   []*scrapeGroup
}

func NewRegistry() *Registry { return &Registry{families: map[string]*family{}} }

func (r *Registry) add(f *family) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, dup := r.families[f.name]; dup {
		panic("metrics: " + f.name + " is declared twice")
	}
	r.families[f.name] = f
}

func (r *Registry) NewCounter(name, help string) *Counter {
	c := &Counter{}
	r.add(&family{name: name, help: help, kind: counterKind, samples: func(*scrape) ([]sample, bool) {
		return []sample{{value: strconv.FormatUint(c.v.Load(), 10)}}, true
	}})
	return c
}

func (r *Registry) NewCounterVec(name, help, label string, values ...string) *CounterVec {
	v := &CounterVec{label: label, counters: make(map[string]*Counter, len(values))}
	for _, val := range values {
		v.counters[val] = &Counter{}
	}
	sorted := slices.Clone(values)
	slices.Sort(sorted)
	r.add(&family{name: name, help: help, kind: counterKind, samples: func(*scrape) ([]sample, bool) {
		out := make([]sample, 0, len(sorted))
		for _, val := range sorted {
			out = append(out, sample{labels: labelPair(label, val), value: strconv.FormatUint(v.counters[val].v.Load(), 10)})
		}
		return out, true
	}})
	return v
}

func (r *Registry) NewGauge(name, help string) *Gauge {
	g := &Gauge{}
	r.add(&family{name: name, help: help, kind: gaugeKind, samples: func(*scrape) ([]sample, bool) {
		return []sample{{value: formatFloat(g.value())}}, true
	}})
	return g
}

// NewGaugeFunc reports fn's value at each scrape. fn must be cheap.
func (r *Registry) NewGaugeFunc(name, help string, fn func() float64) {
	r.add(&family{name: name, help: help, kind: gaugeKind, samples: func(*scrape) ([]sample, bool) {
		return []sample{{value: formatFloat(fn())}}, true
	}})
}

// NewInfo is a gauge fixed at 1 that carries one label, such as the build
// version.
func (r *Registry) NewInfo(name, help, label, value string) {
	r.add(&family{name: name, help: help, kind: gaugeKind, samples: func(*scrape) ([]sample, bool) {
		return []sample{{labels: labelPair(label, value), value: "1"}}, true
	}})
}

// NewScrapeGauges declares gauges whose values one collection computes at
// each scrape (bounded by scrapeTimeout), in the order of descs. When the
// collection fails, all of them are left out of that scrape and errors (if
// not nil) is incremented.
func (r *Registry) NewScrapeGauges(collect func(context.Context) ([]float64, error), errors *Counter, descs ...Desc) {
	g := &scrapeGroup{collect: collect, errors: errors}
	r.mu.Lock()
	r.groups = append(r.groups, g)
	r.mu.Unlock()
	for i, d := range descs {
		r.add(&family{name: d.Name, help: d.Help, kind: gaugeKind, samples: func(s *scrape) ([]sample, bool) {
			res := s.results[g]
			if !res.ok || i >= len(res.values) {
				return nil, false
			}
			return []sample{{value: formatFloat(res.values[i])}}, true
		}})
	}
}

// Write writes every metric in the Prometheus text format, sorted by name.
func (r *Registry) Write(ctx context.Context, w io.Writer) error {
	r.mu.Lock()
	families := make([]*family, 0, len(r.families))
	for _, f := range r.families {
		families = append(families, f)
	}
	groups := slices.Clone(r.groups)
	r.mu.Unlock()
	slices.SortFunc(families, func(a, b *family) int { return strings.Compare(a.name, b.name) })

	// Collections run first, so their error counts show in this scrape.
	ctx, cancel := context.WithTimeout(ctx, scrapeTimeout)
	defer cancel()
	s := &scrape{results: make(map[*scrapeGroup]scrapeResult, len(groups))}
	for _, g := range groups {
		values, err := g.collect(ctx)
		if err != nil {
			g.errors.Inc()
			continue
		}
		s.results[g] = scrapeResult{values: values, ok: true}
	}

	var b strings.Builder
	for _, f := range families {
		lines, ok := f.samples(s)
		if !ok {
			continue
		}
		fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s %s\n", f.name, escapeHelp(f.help), f.name, f.kind)
		for _, l := range lines {
			b.WriteString(f.name)
			b.WriteString(l.labels)
			b.WriteByte(' ')
			b.WriteString(l.value)
			b.WriteByte('\n')
		}
	}
	_, err := io.WriteString(w, b.String())
	return err
}

// Handler serves GET /metrics and nothing else.
func (r *Registry) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, req *http.Request) {
		var b strings.Builder
		if err := r.Write(req.Context(), &b); err != nil {
			http.Error(w, "metrics unavailable", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		_, _ = io.WriteString(w, b.String())
	})
	return mux
}

func labelPair(name, value string) string {
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`)
	return "{" + name + `="` + r.Replace(value) + `"}`
}

func escapeHelp(s string) string {
	return strings.NewReplacer(`\`, `\\`, "\n", `\n`).Replace(s)
}

func formatFloat(v float64) string {
	switch {
	case math.IsInf(v, 1):
		return "+Inf"
	case math.IsInf(v, -1):
		return "-Inf"
	case math.IsNaN(v):
		return "NaN"
	}
	return strconv.FormatFloat(v, 'g', -1, 64)
}
