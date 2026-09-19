package mail

import (
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
