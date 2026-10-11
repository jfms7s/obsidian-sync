// Package admin implements `obsync admin`, the operator's user and device
// management and on-demand maintenance.
package admin

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	"github.com/jfms7s/obsidian-sync/server/internal/blob"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/jobs"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

const (
	minPasswordLen = 8
	// maxPasswordBytes matches the longest password auth.Login accepts; a
	// longer one would create an account that can never log in.
	maxPasswordBytes = 1024
)

var errUsage = errors.New(`usage: obsync admin user create --username NAME [--quota-bytes N]   (password on stdin)
       obsync admin user list
       obsync admin user set-password --username NAME [--revoke-devices]   (password on stdin)
       obsync admin user delete --username NAME [--yes]
       obsync admin user totp (status|disable) --username NAME
       obsync admin device list --username NAME
       obsync admin device revoke --username NAME (--id DEVICE_ID | --all)
       obsync admin maintenance run [--as-of RFC3339]
       obsync admin export --out DIR [--copy] [--wait 2m]
       obsync admin export --prune DIR --keep N`)

type Store interface {
	CreateUser(ctx context.Context, u store.User) error
	UserByUsername(ctx context.Context, username string) (store.User, error)
	ListUsers(ctx context.Context) ([]store.User, error)
	SetPassword(ctx context.Context, userID, hash string) error
	DeleteUser(ctx context.Context, userID string) ([]string, error)
	UserFootprint(ctx context.Context, userID string) (store.Footprint, error)
	ListDevices(ctx context.Context, userID string) ([]store.Device, error)
	RevokeDevice(ctx context.Context, userID, deviceID string) error
	RevokeAllDevices(ctx context.Context, userID string) (int, error)
	TOTP(ctx context.Context, userID string) (store.TOTPState, error)
	DisableTOTP(ctx context.Context, userID string) error
	AcquireLease(ctx context.Context, name, holder string, ttl time.Duration) (bool, error)
	ReleaseLease(ctx context.Context, name, holder string) error
	Snapshot(ctx context.Context, path string) error
}

type Deps struct {
	Store             Store
	Blobs             blob.Store
	DefaultQuotaBytes int64
	Params            auth.Params
	Stdin             io.Reader // the password, one line
	Stdout            io.Writer
	// Maintenance runs one maintenance pass as if the time were now.
	Maintenance func(ctx context.Context, now time.Time) (jobs.Report, error)

	// For export: the configured database URL (only file: is exported), the
	// build version for the manifest, and how to open the snapshot.
	DatabaseURL  string
	Version      string
	OpenSnapshot func(ctx context.Context, path string) (Snapshot, error)
	// Link and Now replace os.Link and time.Now in tests; nil uses them.
	Link func(oldname, newname string) error
	Now  func() time.Time
}

func Run(ctx context.Context, args []string, d Deps) error {
	if len(args) >= 1 && args[0] == "export" {
		return export(ctx, args[1:], d)
	}
	if len(args) < 2 {
		return errUsage
	}
	switch args[0] + " " + args[1] {
	case "user create":
		return userCreate(ctx, args[2:], d)
	case "user list":
		return userList(ctx, d)
	case "user delete":
		return userDelete(ctx, args[2:], d)
	case "user set-password":
		return userSetPassword(ctx, args[2:], d)
	case "user totp":
		return userTOTP(ctx, args[2:], d)
	case "device list":
		return deviceList(ctx, args[2:], d)
	case "device revoke":
		return deviceRevoke(ctx, args[2:], d)
	case "maintenance run":
		return maintenanceRun(ctx, args[2:], d)
	}
	return errUsage
}

func userCreate(ctx context.Context, args []string, d Deps) error {
	fs := flag.NewFlagSet("user create", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	username := fs.String("username", "", "")
	// A string, not fs.Int64: that accepts 0x and leading-zero octal, so
	// "010" would silently mean 8 bytes.
	quotaArg := fs.String("quota-bytes", "", "")
	if err := fs.Parse(args); err != nil {
		return errUsage
	}
	name, err := checkUsername(*username)
	if err != nil {
		return err
	}
	quota := d.DefaultQuotaBytes
	if *quotaArg != "" {
		if quota, err = strconv.ParseInt(*quotaArg, 10, 64); err != nil {
			return errors.New("--quota-bytes must be a decimal number of bytes")
		}
	}
	if quota <= 0 {
		return errors.New("--quota-bytes must be positive")
	}
	hash, err := readAndHash(d)
	if err != nil {
		return err
	}
	err = d.Store.CreateUser(ctx, store.User{ID: ids.New(), Username: name, PasswordHash: hash, QuotaBytes: quota})
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

// userDelete removes a user and everything they own. It cannot be undone,
// so without --yes it only says what it would delete. It never prompts:
// stdin carries passwords, and `kubectl exec` without -it has none.
func userDelete(ctx context.Context, args []string, d Deps) error {
	fs, username := userFlags("user delete")
	yes := fs.Bool("yes", false, "")
	u, err := lookup(ctx, fs, args, username, d)
	if err != nil {
		return err
	}
	if !*yes {
		fp, err := d.Store.UserFootprint(ctx, u.ID)
		if err != nil {
			return err
		}
		fmt.Fprintf(d.Stdout, "user %s has %s, %s, %s and %s; deleting them cannot be undone\n", u.Username,
			plural(fp.Devices, "device"), plural(fp.Vaults, "vault"), plural(fp.Versions, "version"), plural(fp.Blobs, "blob"))
		return errors.New("nothing deleted: re-run with --yes to delete")
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
	fmt.Fprintf(d.Stdout, "deleted user %s (%s removed", u.Username, plural(len(keys)-failed, "blob"))
	if failed > 0 {
		fmt.Fprintf(d.Stdout, ", %d could not be removed and are now orphaned", failed)
	}
	fmt.Fprintln(d.Stdout, ")")
	return nil
}

func userSetPassword(ctx context.Context, args []string, d Deps) error {
	fs, username := userFlags("user set-password")
	revoke := fs.Bool("revoke-devices", false, "")
	u, err := lookup(ctx, fs, args, username, d)
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
	if !*revoke {
		fmt.Fprintf(d.Stdout, "password changed for %s (existing devices stay signed in; add --revoke-devices to sign them all out)\n", u.Username)
		return nil
	}
	n, err := d.Store.RevokeAllDevices(ctx, u.ID)
	if err != nil {
		return fmt.Errorf("password changed, but revoking the devices failed: %w", err)
	}
	fmt.Fprintf(d.Stdout, "password changed for %s; revoked %s\n", u.Username, plural(n, "device"))
	return nil
}

// userTOTP shows whether an account has two-step sign-in on, or turns it
// off: the way back in for a user who lost both the authenticator and the
// recovery codes. Turning it on is the user's own step, in the plugin.
func userTOTP(ctx context.Context, args []string, d Deps) error {
	if len(args) == 0 || (args[0] != "status" && args[0] != "disable") {
		return errUsage
	}
	fs, username := userFlags("user totp " + args[0])
	u, err := lookup(ctx, fs, args[1:], username, d)
	if err != nil {
		return err
	}
	if args[0] == "disable" {
		if err := d.Store.DisableTOTP(ctx, u.ID); err != nil {
			return err
		}
		fmt.Fprintf(d.Stdout, "two-step sign-in turned off for %s; signed-in devices stay signed in\n", u.Username)
		return nil
	}
	st, err := d.Store.TOTP(ctx, u.ID)
	if err != nil {
		return err
	}
	switch {
	case st.Secret != nil:
		fmt.Fprintf(d.Stdout, "two-step sign-in is on for %s (%s left)\n", u.Username, plural(st.RecoveryLeft, "recovery code"))
	case st.PendingSecret != nil:
		fmt.Fprintf(d.Stdout, "two-step sign-in is off for %s (set-up started, not confirmed)\n", u.Username)
	default:
		fmt.Fprintf(d.Stdout, "two-step sign-in is off for %s\n", u.Username)
	}
	return nil
}

func deviceList(ctx context.Context, args []string, d Deps) error {
	fs, username := userFlags("device list")
	u, err := lookup(ctx, fs, args, username, d)
	if err != nil {
		return err
	}
	devices, err := d.Store.ListDevices(ctx, u.ID)
	if err != nil {
		return err
	}
	tw := tabwriter.NewWriter(d.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tNAME\tPLATFORM\tCREATED\tLAST_SEEN\tREVOKED")
	for _, dev := range devices {
		revoked := "-"
		if dev.Revoked() {
			revoked = formatMs(dev.RevokedAtMs)
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n", dev.ID, dev.Name, dev.Platform,
			formatMs(dev.CreatedAtMs), formatMs(dev.LastSeenAtMs), revoked)
	}
	return tw.Flush()
}

func deviceRevoke(ctx context.Context, args []string, d Deps) error {
	fs, username := userFlags("device revoke")
	id := fs.String("id", "", "")
	all := fs.Bool("all", false, "")
	u, err := lookup(ctx, fs, args, username, d)
	if err != nil {
		return err
	}
	if (*id == "") == !*all {
		return errors.New("give either --id DEVICE_ID or --all")
	}
	if *all {
		n, err := d.Store.RevokeAllDevices(ctx, u.ID)
		if err != nil {
			return err
		}
		fmt.Fprintf(d.Stdout, "revoked %s of %s\n", plural(n, "device"), u.Username)
		return nil
	}
	err = d.Store.RevokeDevice(ctx, u.ID, *id)
	if errors.Is(err, store.ErrNotFound) {
		return fmt.Errorf("user %s has no device %q", u.Username, *id)
	}
	if err != nil {
		return err
	}
	fmt.Fprintf(d.Stdout, "revoked 1 device of %s\n", u.Username)
	return nil
}

// maintenanceRun runs one pass of retention pruning, trash purge and chunk
// GC now, or as if the time were --as-of: a later time makes the server's
// data that much older (tests, and operators checking what retention will
// remove). It needs the maintenance lease, which a running server holds only
// while its own pass runs.
func maintenanceRun(ctx context.Context, args []string, d Deps) error {
	fs := flag.NewFlagSet("maintenance run", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	asOfArg := fs.String("as-of", "", "")
	if err := fs.Parse(args); err != nil || fs.NArg() > 0 {
		return errUsage
	}
	asOf := time.Now()
	if *asOfArg != "" {
		t, err := time.Parse(time.RFC3339, *asOfArg)
		if err != nil {
			return errors.New("--as-of must be an RFC 3339 time, such as 2027-01-31T00:00:00Z")
		}
		asOf = t
	}
	if d.Maintenance == nil {
		return errors.New("maintenance is not available")
	}
	rep, err := d.Maintenance(ctx, asOf)
	var held *jobs.LeaseHeldError
	if errors.As(err, &held) {
		return fmt.Errorf("another obsync process holds the maintenance lease (a pass or an export is running, or this database "+
			"was copied during one) until %s, in %s unless it is renewed; try again then",
			held.Until.UTC().Format(time.RFC3339), max(time.Until(held.Until), 0).Round(time.Second))
	}
	if errors.Is(err, jobs.ErrLeaseHeld) {
		return errors.New("another obsync process holds the maintenance lease (a pass or an export is running); try again in a minute")
	}
	if err != nil {
		return err
	}
	fmt.Fprintf(d.Stdout, "maintenance as of %s: %s pruned, %s purged from the trash, %s deleted\n",
		asOf.UTC().Format(time.RFC3339), plural(rep.VersionsPruned, "version"), plural(rep.FilesPurged, "file"),
		plural(rep.ChunksDeleted, "chunk"))
	return nil
}

// userFlags starts a command's flag set with --username.
func userFlags(name string) (*flag.FlagSet, *string) {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return fs, fs.String("username", "", "")
}

// lookup parses args with fs and finds the user named by --username.
func lookup(ctx context.Context, fs *flag.FlagSet, args []string, username *string, d Deps) (store.User, error) {
	if err := fs.Parse(args); err != nil || fs.NArg() > 0 {
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

func formatMs(ms int64) string { return time.UnixMilli(ms).UTC().Format(time.RFC3339) }

func plural(n int, noun string) string {
	if n == 1 {
		return "1 " + noun
	}
	return fmt.Sprintf("%d %ss", n, noun)
}

func checkUsername(s string) (string, error) {
	name := strings.TrimSpace(s)
	if name == "" {
		return "", errors.New("--username is required")
	}
	if !auth.ValidUsername(name) {
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
