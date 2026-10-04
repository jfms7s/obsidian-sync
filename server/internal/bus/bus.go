// Package bus carries "vault X reached seq N" notifications from the replica
// that committed to every replica holding WebSockets for that vault.
package bus

import "context"

type Notify struct {
	VaultID string
	Seq     int64
}

type Bus interface {
	Publish(ctx context.Context, n Notify) error
	// Subscribe delivers notifications for vaultID. The channel holds at most
	// one pending value, the highest seq seen, so a slow reader never blocks
	// publishers. cancel stops delivery and closes the channel; it is idempotent.
	Subscribe(vaultID string) (<-chan Notify, func())
}
