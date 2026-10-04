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
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

const usage = `usage: obsync <command> [--config PATH] [args]

commands:
  serve     run the sync server
  migrate   apply database migrations and exit
  admin     manage users: obsync admin user create|list|delete|set-password

--config defaults to $OBSYNC_CONFIG; OBSYNC_* environment variables override the file.`

func main() {
	if err := run(context.Background(), os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "obsync:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return errors.New(usage)
	}
	cmd := args[0]
	fs := flag.NewFlagSet(cmd, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	configPath := fs.String("config", os.Getenv("OBSYNC_CONFIG"), "")
	if err := fs.Parse(args[1:]); err != nil {
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
	case "admin":
		return adminCmd(ctx, cfg, fs.Args())
	}
	return errors.New(usage)
}

func newLogger(level string) *slog.Logger {
	var l slog.Level
	_ = l.UnmarshalText([]byte(level)) // config.Validate already checked it
	return slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: l}))
}

func serve(ctx context.Context, cfg config.Config, log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
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
	st, err := store.Open(ctx, store.Options{URL: cfg.DatabaseURL, AuthToken: cfg.DatabaseAuthToken})
	if err != nil {
		return err
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		return err
	}
	fmt.Println("migrations applied")
	return nil
}

func adminCmd(ctx context.Context, cfg config.Config, args []string) error {
	st, err := store.Open(ctx, store.Options{URL: cfg.DatabaseURL, AuthToken: cfg.DatabaseAuthToken})
	if err != nil {
		return err
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		return err
	}
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
