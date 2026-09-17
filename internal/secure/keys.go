package secure

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
)

type Keys struct {
	Active string            `json:"active"`
	Values map[string]string `json:"keys"`
}
type Sealed struct {
	KeyID             string
	Nonce, Ciphertext []byte
}

func Load(path string) (*Keys, error) {
	b, e := os.ReadFile(path)
	if e != nil {
		return nil, e
	}
	var k Keys
	if json.Unmarshal(b, &k) != nil {
		return nil, errors.New("invalid key file")
	}
	if _, e = k.aead(k.Active); e != nil {
		return nil, e
	}
	return &k, nil
}
func (k *Keys) aead(id string) (cipher.AEAD, error) {
	b, e := base64.StdEncoding.DecodeString(k.Values[id])
	if e != nil || len(b) != 32 {
		return nil, errors.New("credential encryption key unavailable")
	}
	block, e := aes.NewCipher(b)
	if e != nil {
		return nil, e
	}
	return cipher.NewGCM(block)
}
func (k *Keys) Seal(aad, plaintext string) (Sealed, error) {
	a, e := k.aead(k.Active)
	if e != nil {
		return Sealed{}, e
	}
	nonce := make([]byte, a.NonceSize())
	if _, e = rand.Read(nonce); e != nil {
		return Sealed{}, e
	}
	return Sealed{k.Active, nonce, a.Seal(nil, nonce, []byte(plaintext), []byte(aad))}, nil
}
func (k *Keys) Open(aad string, s Sealed) (string, error) {
	a, e := k.aead(s.KeyID)
	if e != nil {
		return "", e
	}
	if len(s.Nonce) != a.NonceSize() {
		return "", errors.New("invalid credential nonce")
	}
	b, e := a.Open(nil, s.Nonce, s.Ciphertext, []byte(aad))
	if e != nil {
		return "", errors.New("credential authentication failed")
	}
	return string(b), nil
}
func Token() string {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func Hash(v string) string { h := sha256.Sum256([]byte(v)); return hex.EncodeToString(h[:]) }
