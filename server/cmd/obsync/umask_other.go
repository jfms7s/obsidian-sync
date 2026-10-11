//go:build !unix

package main

// restrictUmask does nothing where there is no umask. On Windows a new file
// inherits the ACL of its folder, so the data folder's ACL decides who can
// read it: keep it readable by the service's account only.
func restrictUmask() {}
