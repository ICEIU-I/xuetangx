package mail

import (
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"strings"
	"testing"
)

func TestSMTPMessageIncludesDeliveryMetadata(t *testing.T) {
	s := SMTP{From: "noreply@example.test"}
	message, err := s.message("smtp.example.test", "user@example.test", "Reset your password", "line one\nline two")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := mail.ReadMessage(strings.NewReader(message))
	if err != nil {
		t.Fatal(err)
	}
	for _, header := range []string{"From", "To", "Date", "Message-ID", "Subject", "MIME-Version", "Content-Type"} {
		if parsed.Header.Get(header) == "" {
			t.Fatalf("missing %s header", header)
		}
	}
	if got := parsed.Header.Get("Message-ID"); !strings.HasPrefix(got, "<") || !strings.HasSuffix(got, "@example.test>") {
		t.Fatalf("unexpected Message-ID: %q", got)
	}
	body := make([]byte, 128)
	n, err := parsed.Body.Read(body)
	if err != nil && n == 0 {
		t.Fatal(err)
	}
	if !strings.Contains(string(body[:n]), "line one\r\nline two") {
		t.Fatalf("body was not normalized to CRLF: %q", body[:n])
	}
}

func TestSMTPMessageRejectsHeaderInjection(t *testing.T) {
	s := SMTP{From: "noreply@example.test"}
	if _, err := s.message("smtp.example.test", "user@example.test", "bad\r\nBcc: victim@example.test", "body"); err == nil {
		t.Fatal("header injection was accepted")
	}
}

func TestRichMessageUnicodeAndAlternatives(t *testing.T) {
	subject, plain, html, err := ResetCode("123456")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := (SMTP{From: "noreply@example.test"}).richMessage("smtp.example.test", "user@example.test", subject, plain, html)
	if err != nil {
		t.Fatal(err)
	}
	msg, err := mail.ReadMessage(strings.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := new(mime.WordDecoder).DecodeHeader(msg.Header.Get("Subject"))
	if err != nil || decoded != subject {
		t.Fatal("Unicode subject did not survive MIME encoding")
	}
	from, err := mail.ParseAddress(msg.Header.Get("From"))
	if err != nil || from.Name != "CCF" || from.Address != "noreply@example.test" {
		t.Fatal("bad branded sender")
	}
	kind, params, err := mime.ParseMediaType(msg.Header.Get("Content-Type"))
	if err != nil || kind != "multipart/alternative" {
		t.Fatal("missing multipart alternatives")
	}
	reader := multipart.NewReader(msg.Body, params["boundary"])
	for i, want := range []string{plain, html} {
		p, err := reader.NextPart()
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(p)
		if err != nil {
			t.Fatal(err)
		}
		if strings.ReplaceAll(string(body), "\r\n", "\n") != want {
			t.Fatalf("alternative %d changed", i)
		}
		if !strings.Contains(p.Header.Get("Content-Type"), []string{"text/plain", "text/html"}[i]) {
			t.Fatal("wrong part order")
		}
	}
	if _, err := reader.NextPart(); err != io.EOF {
		t.Fatal("unexpected extra alternative")
	}
	for _, line := range strings.Split(raw, "\r\n") {
		if len(line) > 998 {
			t.Fatal("RFC5322 line too long")
		}
	}
	if strings.Contains(raw, "\r\r\n") {
		t.Fatal("doubled CRLF")
	}
}

func TestMessageEncodingNormalizesCRLF(t *testing.T) {
	raw, err := (SMTP{From: "CCF <noreply@example.test>"}).message("smtp.example.test", "user@example.test", "中文主题", "一\r\n二\n三")
	if err != nil {
		t.Fatal(err)
	}
	msg, err := mail.ReadMessage(strings.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(quotedprintable.NewReader(msg.Body))
	if err != nil || string(body) != "一\r\n二\r\n三" {
		t.Fatal("incorrect line normalization")
	}
	if !strings.HasSuffix(msg.Header.Get("Message-ID"), "@example.test>") {
		t.Fatal("display name leaked into identifier")
	}
}
