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

func TestRegistrationCodeUsesSharedPixelTemplate(t *testing.T) {
	subject, plain, html, err := RegistrationCode("123456")
	if err != nil {
		t.Fatal(err)
	}
	for _, part := range []string{plain, html} {
		if !strings.Contains(part, "注册") || !strings.Contains(part, "123456") || !strings.Contains(part, "10 分钟") {
			t.Fatal("missing registration content")
		}
		if strings.Contains(part, "PASSWORD RESET") || strings.Contains(part, "重置你的密码") {
			t.Fatal("wrong purpose in registration email")
		}
	}
	if subject != "CCF · 注册验证码" || strings.Contains(subject, "123456") {
		t.Fatal("unexpected subject")
	}
	if !strings.Contains(html, "#ef5858") || !strings.Contains(html, "#409bd3") || !strings.Contains(html, "#e8ac20") {
		t.Fatal("missing pixel brand")
	}
	if path := os.Getenv("REGISTRATION_MAIL_PREVIEW_PATH"); path != "" {
		if err := os.WriteFile(path, []byte(html), 0600); err != nil {
			t.Fatal(err)
		}
	}
}
