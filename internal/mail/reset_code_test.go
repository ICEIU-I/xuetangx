package mail

import (
	"os"
	"strings"
	"testing"
)

func TestResetCodeTemplate(t *testing.T) {
	subject, plain, html, err := ResetCode("123456")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(subject, "123456") {
		t.Fatal("code must not appear in subject")
	}
	for _, value := range []string{"123456", "10 分钟", "请勿", "CCF"} {
		if !strings.Contains(plain, value) || !strings.Contains(html, value) {
			t.Fatal("missing mail content")
		}
	}
	for _, unsafe := range []string{"<script", "<svg", "<img", "<link", "<iframe", "http://", "https://", "url(", "+----"} {
		if strings.Contains(html, unsafe) {
			t.Fatal("unexpected external dependency or ASCII frame")
		}
	}
	for _, color := range []string{"#fdf1d6", "#fffdf6", "#ffe9a8", "#1b1a2e", "#ef5858", "#409bd3", "#e8ac20"} {
		if !strings.Contains(html, color) {
			t.Fatal("missing site color")
		}
	}
	if len(html) > 90000 {
		t.Fatal("template risks Gmail clipping")
	}
	for _, invalid := range []string{"", "12345", "1234567", "<html>", "１２３４５６"} {
		if _, _, _, err := ResetCode(invalid); err == nil {
			t.Fatal("invalid code accepted")
		}
	}
	// Opt-in preview uses a dummy code only, never production secrets.
	if path := os.Getenv("MAIL_PREVIEW_PATH"); path != "" {
		if err := os.WriteFile(path, []byte(html), 0600); err != nil {
			t.Fatal(err)
		}
	}
}
