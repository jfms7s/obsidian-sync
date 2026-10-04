package bus_test

import (
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/bus"
	"github.com/jfms7s/obsidian-sync/server/internal/bus/bustest"
)

func TestMemory(t *testing.T) {
	bustest.Run(t, func(t *testing.T) bus.Bus { return bus.NewMemory() })
}
