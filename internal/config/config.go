package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	DatabaseURL, Listen, PublicURL, KeyFile, SMTPAddress, SMTPUser, SMTPPassword, SMTPFrom string
	Development                                                                            bool
	MailEnabled                                                                            bool
	RequireEmailVerification                                                               bool
	TrustedProxies                                                                         []*net.IPNet
	AllowedOrigins                                                                         []string
	GlobalJobs, UserJobs                                                                   int
}

func Load() (Config, error) {
	c := Config{DatabaseURL: os.Getenv("DATABASE_URL"), Listen: env("LISTEN_ADDR", "127.0.0.1:8788"), PublicURL: env("PUBLIC_BASE_URL", "http://127.0.0.1:8788"), KeyFile: os.Getenv("CREDENTIAL_KEY_FILE"), Development: os.Getenv("APP_ENV") == "development", GlobalJobs: 10, UserJobs: 2,
		SMTPAddress: os.Getenv("SMTP_ADDRESS"), SMTPUser: os.Getenv("SMTP_USER"), SMTPPassword: os.Getenv("SMTP_PASSWORD"), SMTPFrom: os.Getenv("SMTP_FROM")}
	var mailErr error
	c.MailEnabled, mailErr = strconv.ParseBool(env("MAIL_ENABLED", "true"))
	if mailErr != nil {
		return c, fmt.Errorf("invalid MAIL_ENABLED")
	}
	c.RequireEmailVerification, mailErr = strconv.ParseBool(env("REQUIRE_EMAIL_VERIFICATION", "true"))
	if mailErr != nil {
		return c, fmt.Errorf("invalid REQUIRE_EMAIL_VERIFICATION")
	}
	if c.RequireEmailVerification && !c.MailEnabled {
		return c, fmt.Errorf("email verification requires MAIL_ENABLED")
	}
	for _, raw := range strings.Split(os.Getenv("TRUSTED_PROXY_CIDRS"), ",") {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		_, network, err := net.ParseCIDR(strings.TrimSpace(raw))
		if err != nil {
			return c, fmt.Errorf("invalid TRUSTED_PROXY_CIDRS")
		}
		c.TrustedProxies = append(c.TrustedProxies, network)
	}
	if v := os.Getenv("DATABASE_URL_FILE"); v != "" {
		b, e := os.ReadFile(v)
		if e != nil {
			return c, e
		}
		c.DatabaseURL = strings.TrimSpace(string(b))
	}
	if v := os.Getenv("SMTP_PASSWORD_FILE"); v != "" {
		b, e := os.ReadFile(v)
		if e != nil {
			return c, e
		}
		c.SMTPPassword = strings.TrimSpace(string(b))
	}
	u, e := url.Parse(c.PublicURL)
	if e != nil || u.Host == "" || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || u.User != nil {
		return c, fmt.Errorf("invalid PUBLIC_BASE_URL")
	}
	if !c.Development && u.Scheme != "https" {
		return c, fmt.Errorf("production PUBLIC_BASE_URL requires HTTPS")
	}
	c.AllowedOrigins, e = parseAllowedOrigins(os.Getenv("ALLOWED_ORIGINS"), c.Development)
	if e != nil {
		return c, e
	}
	if c.DatabaseURL == "" || c.KeyFile == "" {
		return c, fmt.Errorf("DATABASE_URL and CREDENTIAL_KEY_FILE are required")
	}
	for key, dst := range map[string]*int{"MAX_ACTIVE_JOBS": &c.GlobalJobs, "MAX_ACTIVE_JOBS_PER_USER": &c.UserJobs} {
		if v := os.Getenv(key); v != "" {
			n, e := strconv.Atoi(v)
			if e != nil || n < 1 || n > 100 {
				return c, fmt.Errorf("invalid %s", key)
			}
			*dst = n
		}
	}
	if !c.Development && c.MailEnabled && (c.SMTPAddress == "" || c.SMTPFrom == "") {
		return c, fmt.Errorf("SMTP_ADDRESS and SMTP_FROM are required")
	}
	return c, nil
}
func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
