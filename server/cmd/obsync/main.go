// Command obsync is the end-to-end encrypted Obsidian sync server.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"golang.org/x/term"

	"github.com/jfms7s/obsidian-sync/server/internal/admin"
	"github.com/jfms7s/obsidian-sync/server/internal/app"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	"github.com/jfms7s/obsidian-sync/server/internal/blob"
	"github.com/jfms7s/obsidian-sync/server/internal/config"
)

const usage = `usage: obsync [--config PATH] <command> [args]

commands:
  serve     run the sync server
  migrate   apply database migrations and exit
  admin     manage users: obsync admin user create|list|delete|set-password
  version   print the build version
  health    probe GET /readyz on the server's own listen address; exit 0 only on 200

Global flags such as --config go before the command (they are also accepted
right after it, before the command's own arguments).
--config defaults to $OBSYNC_CONFIG; OBSYNC_* environment variables override the file.`

// version is set at build time: -ldflags "-X main.version=v1.2.3".
var version = "dev"

// stdout is where commands print results; tests replace it.
var stdout io.Writer = os.Stdout

func main() {
	if err := run(context.Background(), os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "obsync:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("obsync", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	configPath := fs.String("config", os.Getenv("OBSYNC_CONFIG"), "")
	if err := fs.Parse(args); err != nil {
		return errors.New(usage)
	}
	if fs.NArg() == 0 {
		return errors.New(usage)
	}
	cmd := fs.Arg(0)
	// Global flags may also follow the command, before its own arguments.
	if err := fs.Parse(fs.Args()[1:]); err != nil {
		return errors.New(usage)
	}
	rest := fs.Args()
	switch cmd {
	case "version":
		// Needs no configuration, so a broken config cannot hide it.
		if len(rest) > 0 {
			return fmt.Errorf("%s: unexpected argument %q\n%s", cmd, rest[0], usage)
		}
		_, err := fmt.Fprintln(stdout, "obsync", version)
		return err
	case "serve", "migrate", "health":
		if len(rest) > 0 {
			return fmt.Errorf("%s: unexpected argument %q\n%s", cmd, rest[0], usage)
		}
	case "admin":
	default:
		return errors.New(usage)
	}
	cfg, err := config.Load(*configPath, os.Getenv)
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}
	log := newLogger(cfg.LogLevel)

	switch cmd {
	case "serve":
		return serve(ctx, cfg, log)
	case "migrate":
		return migrate(ctx, cfg)
	case "health":
		return health(ctx, cfg)
	default:
		return adminCmd(ctx, cfg, rest)
	}
}

func newLogger(level string) *slog.Logger {
	var l slog.Level
	_ = l.UnmarshalText([]byte(level)) // config.Validate already checked it
	return slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: l}))
}

func serve(ctx context.Context, cfg config.Config, log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	// Once the first signal starts a graceful shutdown, restore default
	// handling so a second Ctrl-C kills the process immediately.
	go func() { <-ctx.Done(); stop() }()
	a, err := app.Build(ctx, cfg, log, app.Options{})
	if err != nil {
		return err
	}
	defer a.Close()
	ln, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	// Never log the database URL: it may carry credentials.
	log.Info("obsync listening", "addr", ln.Addr().String(), "data_dir", cfg.DataDir)
	return a.Serve(ctx, ln)
}

func migrate(ctx context.Context, cfg config.Config) error {
	st, err := app.OpenStore(ctx, cfg)
	if err != nil {
		return err
	}
	defer st.Close()
	fmt.Println("migrations applied")
	return nil
}

// healthTimeout (a variable only so tests can shorten it) bounds the whole probe; the container runtime's own timeout
// is longer, so a hung server is reported by this command first.
var healthTimeout = 3 * time.Second

// health probes the running server for container HEALTHCHECKs, where the
// image has no shell or curl. It succeeds only on a plain 200 from /readyz.
func health(ctx context.Context, cfg config.Config) error {
	target, err := healthTarget(cfg.Listen)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, healthTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+target+"/readyz", http.NoBody)
	if err != nil {
		return fmt.Errorf("health: %w", err)
	}
	client := &http.Client{
		// The probe talks to the local server directly: never via a proxy,
		// and a redirect is a failure, not something to chase.
		Transport:     &http.Transport{Proxy: nil},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("health: GET /readyz on %s: %w", target, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
		reason := strings.Join(strings.Fields(string(snippet)), " ")
		return fmt.Errorf("health: GET /readyz on %s returned %d %s", target, resp.StatusCode, reason)
	}
	return nil
}

// healthTarget turns the listen address into one a local client can dial: an
// empty or unspecified host (":8080", "0.0.0.0:8080", "[::]:8080") means
// every interface, so the loopback address is used.
func healthTarget(listen string) (string, error) {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return "", fmt.Errorf("health: listen address %q: %w", listen, err)
	}
	if port == "" {
		return "", fmt.Errorf("health: listen address %q has no port", listen)
	}
	if addr, err := netip.ParseAddr(host); host == "" || (err == nil && addr.IsUnspecified()) {
		host = "127.0.0.1"
	}
	return net.JoinHostPort(host, port), nil
}

func adminCmd(ctx context.Context, cfg config.Config, args []string) error {
	st, err := app.OpenStore(ctx, cfg)
	if err != nil {
		return err
	}
	defer st.Close()
	blobs, err := blob.NewFS(cfg.BlobFSDir)
	if err != nil {
		return err
	}
	stdin, err := passwordInput(args)
	if err != nil {
		return err
	}
	return admin.Run(ctx, args, admin.Deps{
		Store: st, Blobs: blobs, DefaultQuotaBytes: cfg.DefaultQuotaBytes, Params: auth.DefaultParams,
		Stdin: stdin, Stdout: os.Stdout,
	})
}

// passwordInput prompts twice without echo when stdin is a terminal and the
// command needs a password; otherwise the password is read from stdin.
func passwordInput(args []string) (io.Reader, error) {
	needs := len(args) >= 2 && (args[1] == "create" || args[1] == "set-password")
	fd := int(os.Stdin.Fd())
	if !needs || !term.IsTerminal(fd) {
		return os.Stdin, nil
	}
	fmt.Fprint(os.Stderr, "Password: ")
	first, err := term.ReadPassword(fd)
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return nil, err
	}
	fmt.Fprint(os.Stderr, "Repeat password: ")
	second, err := term.ReadPassword(fd)
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return nil, err
	}
	if string(first) != string(second) {
		return nil, errors.New("passwords do not match")
	}
	return strings.NewReader(string(first) + "\n"), nil
}
