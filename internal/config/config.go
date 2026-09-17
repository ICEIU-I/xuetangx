package config

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	DatabaseURL, Listen, PublicURL, KeyFile, SMTPAddress, SMTPUser, SMTPPassword, SMTPFrom string
	Development                                                                            bool
	GlobalJobs, UserJobs                                                                   int
}

func Load() (Config, error) {
	c := Config{DatabaseURL: os.Getenv("DATABASE_URL"), Listen: env("LISTEN_ADDR", "127.0.0.1:8788"), PublicURL: env("PUBLIC_BASE_URL", "http://127.0.0.1:8788"), KeyFile: os.Getenv("CREDENTIAL_KEY_FILE"), Development: os.Getenv("APP_ENV") == "development", GlobalJobs: 10, UserJobs: 2,
		SMTPAddress: os.Getenv("SMTP_ADDRESS"), SMTPUser: os.Getenv("SMTP_USER"), SMTPPassword: os.Getenv("SMTP_PASSWORD"), SMTPFrom: os.Getenv("SMTP_FROM")}
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
	if !c.Development && (c.SMTPAddress == "" || c.SMTPFrom == "") {
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
