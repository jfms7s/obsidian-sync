package auth

// SetVerify replaces the password check s uses, so tests can observe and slow
// down verification.
func SetVerify(s *Service, f func(password, encoded string) (bool, error)) { s.verify = f }

// SetMaxTrackedKeys lowers how many keys l tracks, so tests can reach the cap.
func SetMaxTrackedKeys(l *LoginLimiter, n int) { l.maxKeys = n }

// TrackedKeys reports how many keys l currently tracks.
func TrackedKeys(l *LoginLimiter) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}
