package secure

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestAuthenticatedEncryptionAndRotation(t *testing.T) {
	k := &Keys{Active: "first", Values: map[string]string{"first": base64.StdEncoding.EncodeToString([]byte(strings.Repeat("a", 32)))}}
	s, e := k.Seal("owner:account", "sessionid=private")
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(string(s.Ciphertext), "private") {
		t.Fatal("plaintext leaked")
	}
	if _, e = k.Open("other:account", s); e == nil {
		t.Fatal("cross-owner decrypt")
	}
	k.Values["next"] = base64.StdEncoding.EncodeToString([]byte(strings.Repeat("b", 32)))
	k.Active = "next"
	v, e := k.Open("owner:account", s)
	if e != nil || v != "sessionid=private" {
		t.Fatal(e)
	}
	delete(k.Values, "first")
	if _, e = k.Open("owner:account", s); e == nil {
		t.Fatal("missing key accepted")
	}
}
func TestPasswords(t *testing.T) {
	h, e := Password("a-long-password-123")
	if e != nil {
		t.Fatal(e)
	}
	if !CheckPassword("a-long-password-123", h) || CheckPassword("wrong", h) {
		t.Fatal("password validation")
	}
}

func TestPasswordLengthBoundaries(t *testing.T) {
	for _, password := range []string{"x", "字", strings.Repeat("a", 256)} {
		hash, err := Password(password)
		if err != nil || !CheckPassword(password, hash) {
			t.Fatalf("valid password rejected: %v", err)
		}
	}
	for _, password := range []string{"", strings.Repeat("a", 257)} {
		if _, err := Password(password); err == nil {
			t.Fatal("invalid password accepted")
		}
	}
}
