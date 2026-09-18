package config

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseAllowedOrigins(t *testing.T) {
	tests := []struct {
		name, value string
		development bool
		want        []string
	}{
		{"unset", "", false, []string{}},
		{"blank", "  \t", false, []string{}},
		{"production domains", "https://primary.test,https://legacy.test", false, []string{"https://primary.test", "https://legacy.test"}},
		{"trim and deduplicate", " https://example.test , https://example.test, https://second.test:8443 ", false, []string{"https://example.test", "https://second.test:8443"}},
		{"local development", "http://localhost:8788,http://127.0.0.1:8788,http://[::1]:8788", true, []string{"http://localhost:8788", "http://127.0.0.1:8788", "http://[::1]:8788"}},
		{"IPv6 HTTPS", "https://[2001:db8::1]:443", false, []string{"https://[2001:db8::1]:443"}},
		{"punycode domain", "https://xn--bcher-kva.example", false, []string{"https://xn--bcher-kva.example"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseAllowedOrigins(tt.value, tt.development)
			if err != nil || !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("parseAllowedOrigins() = %v, %v; want %v", got, err, tt.want)
			}
		})
	}
}

func TestParseAllowedOriginsRejectsInvalidValues(t *testing.T) {
	invalid := []string{
		"*", "null", "https://*.example.test", "//example.test", "example.test", "ftp://example.test",
		"https://example.test/", "https://example.test/path", "https://example.test/%2f", "https://example.test?", "https://example.test?q=1", "https://example.test#", "https://example.test#fragment",
		"https://user@example.test", "https://user:password@example.test", "https://@example.test",
		"https://", "https://.example.test", "https://example..test", "https://-example.test", "https://example-.test", "https://example_test", "https://例子.test", "https://" + strings.Repeat("a", 64) + ".test",
		"https://example.test:", "https://example.test:0", "https://example.test:65536", "https://example.test:-1", "https://example.test:abc", "https://example.test:443:443",
		"https://256.1.1.1", "https://127.1", "https://2130706433", "https://127.00.0.1", "https://::1", "https://[127.0.0.1]", "https://[::g]", "https://[fe80::1%25en0]",
		"https://exa mple.test", "https://example.\ttest", "https://example.\ntest", "https://exa\u00a0mple.test",
		",", ",https://example.test", "https://example.test,", "https://example.test,,https://second.test",
	}
	for _, value := range invalid {
		t.Run(value, func(t *testing.T) {
			for _, development := range []bool{false, true} {
				if _, err := parseAllowedOrigins(value, development); err == nil {
					t.Fatalf("accepted invalid origin %q (development=%t)", value, development)
				}
			}
		})
	}
	if _, err := parseAllowedOrigins("http://example.test", false); err == nil {
		t.Fatal("production accepted HTTP origin")
	}
}

func TestLoadAllowedOrigins(t *testing.T) {
	for _, key := range []string{"DATABASE_URL_FILE", "SMTP_PASSWORD_FILE", "TRUSTED_PROXY_CIDRS", "MAX_ACTIVE_JOBS", "MAX_ACTIVE_JOBS_PER_USER"} {
		t.Setenv(key, "")
	}
	t.Setenv("APP_ENV", "production")
	t.Setenv("PUBLIC_BASE_URL", "https://primary.test")
	t.Setenv("DATABASE_URL", "postgres://unused")
	t.Setenv("CREDENTIAL_KEY_FILE", "unused")
	t.Setenv("MAIL_ENABLED", "false")
	t.Setenv("REQUIRE_EMAIL_VERIFICATION", "false")
	t.Setenv("ALLOWED_ORIGINS", "https://legacy.test")
	cfg, err := Load()
	if err != nil || !reflect.DeepEqual(cfg.AllowedOrigins, []string{"https://legacy.test"}) || cfg.PublicURL != "https://primary.test" {
		t.Fatalf("Load() origins=%v, publicURL=%q, err=%v", cfg.AllowedOrigins, cfg.PublicURL, err)
	}
	t.Setenv("ALLOWED_ORIGINS", "")
	cfg, err = Load()
	if err != nil || len(cfg.AllowedOrigins) != 0 {
		t.Fatalf("unset ALLOWED_ORIGINS changed compatibility: %v, %v", cfg.AllowedOrigins, err)
	}
	t.Setenv("ALLOWED_ORIGINS", "https://*.example.test")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "ALLOWED_ORIGINS") {
		t.Fatalf("invalid setting did not fail configuration: %v", err)
	}
	t.Setenv("ALLOWED_ORIGINS", "http://localhost:8788")
	if _, err := Load(); err == nil {
		t.Fatal("production accepted HTTP origin")
	}
	t.Setenv("APP_ENV", "development")
	if _, err := Load(); err != nil {
		t.Fatalf("development HTTP origin rejected: %v", err)
	}
}
