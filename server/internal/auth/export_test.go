package auth

// SetVerify replaces the password check s uses, so tests can observe and slow
// down verification.
func SetVerify(s *Service, f func(password, encoded string) (bool, error)) { s.verify = f }
