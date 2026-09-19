package secure

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestCodeMACIsKeyedAndScoped(t *testing.T) {
	k := &Keys{Active: "a", Values: map[string]string{"a": base64.StdEncoding.EncodeToString([]byte(strings.Repeat("a", 32))), "b": base64.StdEncoding.EncodeToString([]byte(strings.Repeat("b", 32)))}}
	x, e := k.MAC("a", "register:user-a", "123456")
	if e != nil {
		t.Fatal(e)
	}
	for _, v := range []struct{ key, purpose, code string }{{"b", "register:user-a", "123456"}, {"a", "register:user-b", "123456"}, {"a", "register:user-a", "123457"}} {
		got, e := k.MAC(v.key, v.purpose, v.code)
		if e != nil || got == x {
			t.Fatal("digest not scoped")
		}
	}
	if _, e := k.MAC("missing", "register", "123456"); e == nil {
		t.Fatal("missing key accepted")
	}
}
