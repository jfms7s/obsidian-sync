// Package admin implements `obsync admin`, the operator's user management.
package admin

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"regexp"
	"strings"
	"text/tabwriter"

	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	"github.com/jfms7s/obsidian-sync/server/internal/blob"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

const (
	minPasswordLen = 8
	// maxPasswordBytes matches the longest password auth.Login accepts; a
	// longer one would create an account that can never log in.
	maxPasswordBytes = 1024
)

var (
	errUsage      = errors.New("usage: obsync admin user create|list|delete|set-password [--username NAME] [--quota-bytes N]")
	validUsername = regexp.MustCompile(`^[A-Za-z0-9._@-]{1,64}$`)
)

type Store interface {
	CreateUser(ctx context.Context, u store.User) error
	UserByUsername(ctx context.Context, username string) (store.User, error)
	ListUsers(ctx context.Context) ([]store.User, error)
	SetPassword(ctx context.Context, userID, hash string) error
	DeleteUser(ctx context.Context, userID string) ([]string, error)
}

type Deps struct {
	Store             Store
	Blobs             blob.Store
	DefaultQuotaBytes int64
	Params            auth.Params
	Stdin             io.Reader // the password, one line
	Stdout            io.Writer
}

func Run(ctx context.Context, args []string, d Deps) error {
	if len(args) < 2 || args[0] != "user" {
		return errUsage
	}
	switch args[1] {
	case "create":
		return userCreate(ctx, args[2:], d)
	case "list":
		return userList(ctx, d)
	case "delete":
		return userDelete(ctx, args[2:], d)
	case "set-password":
		return userSetPassword(ctx, args[2:], d)
	}
	return errUsage
}

func userCreate(ctx context.Context, args []string, d Deps) error {
	fs := flag.NewFlagSet("user create", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	username := fs.String("username", "", "")
	quota := fs.Int64("quota-bytes", d.DefaultQuotaBytes, "")
	if err := fs.Parse(args); err != nil {
		return errUsage
	}
	name, err := checkUsername(*username)
	if err != nil {
		return err
	}
	if *quota <= 0 {
		return errors.New("--quota-bytes must be positive")
	}
	hash, err := readAndHash(d)
	if err != nil {
		return err
	}
	err = d.Store.CreateUser(ctx, store.User{ID: ids.New(), Username: name, PasswordHash: hash, QuotaBytes: *quota})
	if errors.Is(err, store.ErrExists) {
		return fmt.Errorf("user %q already exists", name)
	}
	if err != nil {
		return err
	}
	fmt.Fprintf(d.Stdout, "created user %s\n", name)
	return nil
}

func userList(ctx context.Context, d Deps) error {
	users, err := d.Store.ListUsers(ctx)
	if err != nil {
		return err
	}
	tw := tabwriter.NewWriter(d.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "USERNAME\tID\tQUOTA_BYTES")
	for _, u := range users {
		fmt.Fprintf(tw, "%s\t%s\t%d\n", u.Username, u.ID, u.QuotaBytes)
	}
	return tw.Flush()
}

func userDelete(ctx context.Context, args []string, d Deps) error {
	u, err := lookup(ctx, args, "user delete", d)
	if err != nil {
		return err
	}
	keys, err := d.Store.DeleteUser(ctx, u.ID)
	if err != nil {
		return err
	}
	failed := 0
	for _, k := range keys {
		if err := d.Blobs.Delete(ctx, k); err != nil {
			failed++
		}
	}
	fmt.Fprintf(d.Stdout, "deleted user %s (%d blobs removed", u.Username, len(keys)-failed)
	if failed > 0 {
		fmt.Fprintf(d.Stdout, ", %d could not be removed and are now orphaned", failed)
	}
	fmt.Fprintln(d.Stdout, ")")
	return nil
}

func userSetPassword(ctx context.Context, args []string, d Deps) error {
	u, err := lookup(ctx, args, "user set-password", d)
	if err != nil {
		return err
	}
	hash, err := readAndHash(d)
	if err != nil {
		return err
	}
	if err := d.Store.SetPassword(ctx, u.ID, hash); err != nil {
		return err
	}
	fmt.Fprintf(d.Stdout, "password changed for %s (existing devices stay signed in; revoke them from a device if needed)\n", u.Username)
	return nil
}

func lookup(ctx context.Context, args []string, name string, d Deps) (store.User, error) {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	username := fs.String("username", "", "")
	if err := fs.Parse(args); err != nil {
		return store.User{}, errUsage
	}
	if *username == "" {
		return store.User{}, errors.New("--username is required")
	}
	u, err := d.Store.UserByUsername(ctx, *username)
	if errors.Is(err, store.ErrNotFound) {
		return store.User{}, fmt.Errorf("no user named %q", *username)
	}
	return u, err
}

func checkUsername(s string) (string, error) {
	name := strings.TrimSpace(s)
	if name == "" {
		return "", errors.New("--username is required")
	}
	if !validUsername.MatchString(name) {
		return "", errors.New("usernames are 1-64 characters of letters, digits and . _ @ -")
	}
	return name, nil
}

func readAndHash(d Deps) (string, error) {
	line, err := bufio.NewReader(d.Stdin).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", fmt.Errorf("read password: %w", err)
	}
	password := strings.TrimRight(line, "\r\n")
	if len(password) < minPasswordLen {
		return "", fmt.Errorf("the password must be at least %d characters", minPasswordLen)
	}
	if len(password) > maxPasswordBytes {
		return "", fmt.Errorf("the password must be at most %d bytes", maxPasswordBytes)
	}
	return auth.HashPassword(password, d.Params)
}
