package api

import "time"

// SetBodyReadTimeouts shortens the body read deadlines for a test and returns
// a function that restores them.
func SetBodyReadTimeouts(proto, chunk time.Duration) (restore func()) {
	oldProto, oldChunk := protoBodyTimeout, chunkBodyTimeout
	protoBodyTimeout, chunkBodyTimeout = proto, chunk
	return func() { protoBodyTimeout, chunkBodyTimeout = oldProto, oldChunk }
}
