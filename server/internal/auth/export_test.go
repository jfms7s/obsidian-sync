package auth

// SetVerify replaces the password check s uses, so tests can observe and slow
// down verification.
func SetVerify(s *Service, f func(password, encoded string) (bool, error)) { s.verify = f }

// SetMaxTrackedKeys lowers how many keys l tracks, so tests can reach the cap.
// Call it before l is used: it starts from empty buckets.
func SetMaxTrackedKeys(l *LoginLimiter, n int) { l.l = l.newLimiter(n) }

// TrackedKeys reports how many keys l currently tracks.
func TrackedKeys(l *LoginLimiter) int { return l.l.Len() }

// Tracks reports whether l currently holds a bucket for key.
func Tracks(l *LoginLimiter, key string) bool { return l.l.Contains(key) }
