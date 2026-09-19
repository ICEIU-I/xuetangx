package secure

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
)

// MAC protects low-entropy codes against offline guesses from a database copy.
// keyID allows an outstanding code to survive key rotation while that key is retained.
func (k *Keys) MAC(keyID, purpose, value string) (string, error) {
	if k == nil {
		return "", fmt.Errorf("code key unavailable")
	}
	key, err := base64.StdEncoding.DecodeString(k.Values[keyID])
	if err != nil || len(key) != 32 {
		return "", fmt.Errorf("code key unavailable")
	}
	m := hmac.New(sha256.New, key)
	m.Write([]byte(purpose))
	m.Write([]byte{0})
	m.Write([]byte(value))
	return hex.EncodeToString(m.Sum(nil)), nil
}
