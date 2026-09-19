package mail

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/mail"
	"net/smtp"
	"time"
)

type SMTP struct {
	Address, User, Password, From string
	AllowPlainLocal               bool
}

func (s SMTP) Send(ctx context.Context, to, subject, body string) error {
	return s.send(ctx, to, subject, body, "")
}

func (s SMTP) SendRich(ctx context.Context, to, subject, plain, html string) error {
	return s.send(ctx, to, subject, plain, html)
}

func (s SMTP) send(ctx context.Context, to, subject, plain, html string) error {
	host, _, e := net.SplitHostPort(s.Address)
	if e != nil {
		return e
	}
	message, e := s.richMessage(host, to, subject, plain, html)
	if e != nil {
		return e
	}
	fromAddress, e := mail.ParseAddress(s.From)
	if e != nil {
		return e
	}
	toAddress, e := mail.ParseAddress(to)
	if e != nil {
		return e
	}
	conn, e := (&net.Dialer{Timeout: 15 * time.Second}).DialContext(ctx, "tcp", s.Address)
	if e != nil {
		return e
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(30 * time.Second))
	client, e := smtp.NewClient(conn, host)
	if e != nil {
		return e
	}
	defer client.Close()
	if ok, _ := client.Extension("STARTTLS"); ok {
		if e = client.StartTLS(&tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}); e != nil {
			return e
		}
	} else if !s.AllowPlainLocal {
		return fmt.Errorf("SMTP requires STARTTLS")
	}
	if s.User != "" {
		if e = client.Auth(smtp.PlainAuth("", s.User, s.Password, host)); e != nil {
			return e
		}
	}
	if e = client.Mail(fromAddress.Address); e != nil {
		return e
	}
	if e = client.Rcpt(toAddress.Address); e != nil {
		return e
	}
	w, e := client.Data()
	if e != nil {
		return e
	}
	_, e = fmt.Fprint(w, message)
	if e != nil {
		return e
	}
	if e = w.Close(); e != nil {
		return e
	}
	return client.Quit()
}
