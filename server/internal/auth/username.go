package auth

import "regexp"

var usernamePattern = regexp.MustCompile(`^[A-Za-z0-9._@-]{1,64}$`)

// ValidUsername reports whether name is a username an account can have:
// 1-64 letters, digits and . _ @ -. Callers trim surrounding spaces first.
func ValidUsername(name string) bool { return usernamePattern.MatchString(name) }
