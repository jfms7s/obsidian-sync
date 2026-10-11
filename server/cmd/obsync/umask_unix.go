//go:build unix

package main

import "syscall"

// restrictUmask makes every file and directory obsync creates private to its
// own user (files 0600, directories 0700).
func restrictUmask() { syscall.Umask(0o077) }
