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
	"os"
	"os/signal"
	"strings"
	"syscall"

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

Global flags such as --config go before the command (they are also accepted
right after it, before the command's own arguments).
--config defaults to $OBSYNC_CONFIG; OBSYNC_* environment variables override the file.`

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
	case "serve", "migrate":
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
