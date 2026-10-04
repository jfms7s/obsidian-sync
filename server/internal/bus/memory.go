package bus

import (
	"context"
	"sync"
)

// Memory is the single-node Bus.
type Memory struct {
	mu   sync.Mutex
	subs map[string]map[*subscriber]struct{}
}

type subscriber struct{ ch chan Notify }

func NewMemory() *Memory { return &Memory{subs: map[string]map[*subscriber]struct{}{}} }

func (m *Memory) Publish(_ context.Context, n Notify) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for s := range m.subs[n.VaultID] {
		// Publish is the only sender and holds mu, so after the drain below the
		// buffered slot is free and the send cannot block.
		out := n
		select {
		case old := <-s.ch:
			if old.Seq > out.Seq {
				out.Seq = old.Seq
			}
		default:
		}
		s.ch <- out
	}
	return nil
}

func (m *Memory) Subscribe(vaultID string) (<-chan Notify, func()) {
	s := &subscriber{ch: make(chan Notify, 1)}
	m.mu.Lock()
	if m.subs[vaultID] == nil {
		m.subs[vaultID] = map[*subscriber]struct{}{}
	}
	m.subs[vaultID][s] = struct{}{}
	m.mu.Unlock()

	var once sync.Once
	cancel := func() {
		once.Do(func() {
			m.mu.Lock()
			defer m.mu.Unlock()
			delete(m.subs[vaultID], s)
			if len(m.subs[vaultID]) == 0 {
				delete(m.subs, vaultID)
			}
			close(s.ch)
		})
	}
	return s.ch, cancel
}
