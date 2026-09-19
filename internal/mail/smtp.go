package mail

import (
	"context"
	"crypto/tls"
	"fmt"
	"github.com/google/uuid"
	"net"
	"net/smtp"
	"strings"
	"time"
)

type SMTP struct {
	Address, User, Password, From string
	AllowPlainLocal               bool
}

func (s SMTP) Send(ctx context.Context, to, subject, body string) error {
	if strings.ContainsAny(to+subject+s.From, "\r\n") {
		return fmt.Errorf("invalid mail header")
	}
	host, _, e := net.SplitHostPort(s.Address)
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
	if e = client.Mail(s.From); e != nil {
		return e
	}
	if e = client.Rcpt(to); e != nil {
		return e
	}
	w, e := client.Data()
	if e != nil {
		return e
	}
	message, e := s.message(host, to, subject, body)
	if e == nil {
		_, e = fmt.Fprint(w, message)
	}
	if e != nil {
		return e
	}
	if e = w.Close(); e != nil {
		return e
	}
	return client.Quit()
}

// message builds a small RFC 5322 message with stable delivery metadata. Date
// and Message-ID are important for mailbox threading and spam classification;
// they are generated per delivery attempt so a retried message is not given a
// stale identifier.
func (s SMTP) message(host, to, subject, body string) (string, error) {
	if strings.ContainsAny(to+subject+s.From, "\r\n") {
		return "", fmt.Errorf("invalid mail header")
	}
	messageIDDomain := host
	if at := strings.LastIndexByte(s.From, '@'); at > 0 && at < len(s.From)-1 {
		// Keep the identifier in the sender's domain. This is more useful to
		// mailbox threading than exposing the relay host in Message-ID.
		messageIDDomain = s.From[at+1:]
	}
	messageID := fmt.Sprintf("<%s@%s>", uuid.NewString(), messageIDDomain)
	date := time.Now().UTC().Format(time.RFC1123Z)
	return fmt.Sprintf("From: %s\r\nTo: %s\r\nDate: %s\r\nMessage-ID: %s\r\nSubject: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n%s\r\n", s.From, to, date, messageID, subject, strings.ReplaceAll(body, "\n", "\r\n")), nil
}
