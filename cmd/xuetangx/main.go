package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
	"xuetangx/internal/accounts"
	"xuetangx/internal/auth"
	"xuetangx/internal/bank"
	"xuetangx/internal/catalog"
	"xuetangx/internal/config"
	"xuetangx/internal/httpapi"
	"xuetangx/internal/mail"
	"xuetangx/internal/operations"
	"xuetangx/internal/platform"
	"xuetangx/internal/process"
	"xuetangx/internal/secure"
	"xuetangx/internal/store"
	"xuetangx/internal/webassets"
	"xuetangx/internal/workflow"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		client := &http.Client{Timeout: 3 * time.Second}
		res, err := client.Get("http://127.0.0.1:8788/health/ready")
		if err != nil {
			os.Exit(1)
		}
		res.Body.Close()
		if res.StatusCode != 200 {
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "worker" {
		if e := process.Worker(os.Stdin, os.Stdout); e != nil {
			fmt.Fprintln(os.Stderr, e)
			os.Exit(2)
		}
		return
	}
	flags := flag.NewFlagSet("xuetangx", flag.ExitOnError)
	migrate := flags.Bool("migrate", false, "run migrations and exit")
	admin := flags.String("bootstrap-admin", "", "create verified administrator")
	_ = flags.Parse(os.Args[1:])
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stderr, nil)))
	ctx, stopCancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stopCancel()
	cfg, e := config.Load()
	if e != nil {
		fatal(e)
	}
	if e = store.Migrate(ctx, cfg.DatabaseURL); e != nil {
		fatal(e)
	}
	if *migrate {
		return
	}
	db, e := store.Open(ctx, cfg.DatabaseURL)
	if e != nil {
		fatal(e)
	}
	defer db.Close()
	keys, e := secure.Load(cfg.KeyFile)
	if e != nil {
		fatal(e)
	}
	queue := &mail.Queue{DB: db, Keys: keys}
	if cfg.MailEnabled && cfg.SMTPAddress != "" {
		queue.Sender = mail.SMTP{Address: cfg.SMTPAddress, User: cfg.SMTPUser, Password: cfg.SMTPPassword, From: cfg.SMTPFrom, AllowPlainLocal: cfg.Development}
	}
	if *admin != "" {
		password := os.Getenv("ADMIN_PASSWORD")
		if password == "" {
			fatal(fmt.Errorf("ADMIN_PASSWORD is required"))
		}
		if e = auth.New(db, queue, cfg.PublicURL).Bootstrap(ctx, *admin, password); e != nil {
			fatal(e)
		}
		return
	}
	if cfg.MailEnabled {
		go queue.Run(ctx)
	}
	a := auth.New(db, queue, cfg.PublicURL)
	a.RequireEmailVerification = cfg.RequireEmailVerification
	httpClient := platform.NewClient()
	ac := accounts.New(db, keys, httpClient.Authenticate)
	broker := platform.NewBroker(ac, httpClient)
	b := &bank.Service{DB: db}
	cat := &catalog.Service{DB: db, Request: broker.Call}
	ops := operations.New(&operations.Journal{DB: db}, b, cat, broker.Call)
	engine, e := workflow.New(ctx, db, ac, b, cat, broker, ops, cfg.GlobalJobs, cfg.UserJobs)
	if e != nil {
		fatal(e)
	}
	defer engine.Close()
	a.OnDisabled = engine.Disable
	server := httpapi.New(a, ac, engine, cat)
	if e = server.ConfigureTrafficFile(cfg.TrafficFile); e != nil {
		fatal(e)
	}
	server.WeChat = accounts.NewWeChatLogin(ac, platform.NewWeChatClient())
	defer server.WeChat.Close()
	server.EmailDisabled = !cfg.MailEnabled
	server.TrustedProxies = cfg.TrustedProxies
	server.Assets, e = webassets.FS()
	if e != nil {
		fatal(fmt.Errorf("frontend missing: run make build"))
	}
	srv := &http.Server{Addr: cfg.Listen, Handler: server.Handler(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 120 * time.Second}
	go func() {
		slog.Info("server listening", "address", cfg.Listen)
		if e := srv.ListenAndServe(); e != nil && e != http.ErrServerClosed {
			fatal(e)
		}
	}()
	<-ctx.Done()
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdown)
}
func fatal(e error) { fmt.Fprintln(os.Stderr, e); os.Exit(1) }
