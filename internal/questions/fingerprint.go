package questions

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"xuetangx/internal/domain"
	"xuetangx/internal/platform/wire"
)

func digest(v []byte) string { s := sha256.Sum256(v); return hex.EncodeToString(s[:]) }
func normalized(p domain.Problem, legacy bool) []byte {
	var c map[string]json.RawMessage
	_ = json.Unmarshal(p.Content, &c)
	defaults := map[string]string{"type": "null", "body": "\"\"", "options": "[]", "blanks": "[]", "version": "null"}
	keys := []string{"type", "body", "options", "blanks", "version"}
	source := []string{"Type", "Body", "Options", "Blanks", "Version"}
	var out strings.Builder
	out.WriteByte('{')
	for i, k := range keys {
		if i > 0 {
			out.WriteByte(',')
		}
		out.WriteString(strconv.Quote(k))
		out.WriteByte(':')
		raw := c[source[i]]
		if k == "blanks" && len(raw) == 0 {
			raw = c["blanks"]
		}
		var parsed any
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &parsed)
		}
		if len(raw) == 0 || (legacy && !wire.Truthy(parsed)) {
			raw = []byte(defaults[k])
		}
		out.Write(raw)
	}
	out.WriteByte('}')
	return []byte(out.String())
}
func Fingerprint(p domain.Problem) string {
	b, e := stringify(normalized(p, false), true)
	if e != nil {
		return ""
	}
	return digest(append([]byte("v3\n"), b...))
}
func LegacyFingerprints(p domain.Problem) []string {
	out := []string{}
	for _, v := range [][]byte{p.Content, normalized(p, true)} {
		if b, e := stringify(v, false); e == nil {
			out = append(out, digest(b))
		}
	}
	return out
}
func Matches(p domain.Problem, hash, algorithm string) bool {
	if algorithm == "canonical-v3" {
		return hash == Fingerprint(p)
	}
	for _, v := range LegacyFingerprints(p) {
		if hash == v {
			return true
		}
	}
	return false
}

type pair struct{ key, value string }

func stringify(raw []byte, canonical bool) ([]byte, error) {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	v, e := readValue(d, canonical)
	if e != nil {
		return nil, e
	}
	if _, e = d.Token(); e != io.EOF {
		return nil, fmt.Errorf("trailing JSON")
	}
	return []byte(v), nil
}
func readValue(d *json.Decoder, canonical bool) (string, error) {
	token, e := d.Token()
	if e != nil {
		return "", e
	}
	switch v := token.(type) {
	case nil:
		return "null", nil
	case bool:
		return strconv.FormatBool(v), nil
	case string:
		return quote(v), nil
	case json.Number:
		n, e := strconv.ParseFloat(string(v), 64)
		if e != nil {
			return "", e
		}
		if n == 0 {
			return "0", nil
		}
		format := byte('f')
		if n >= 1e21 || n <= -1e21 || (n < 1e-6 && n > 0) || (n > -1e-6 && n < 0) {
			format = 'e'
		}
		s := strconv.FormatFloat(n, format, -1, 64)
		s = strings.ReplaceAll(s, "e-0", "e-")
		s = strings.ReplaceAll(s, "e+0", "e+")
		return s, nil
	case json.Delim:
		if v == '[' {
			values := []string{}
			for d.More() {
				s, e := readValue(d, canonical)
				if e != nil {
					return "", e
				}
				values = append(values, s)
			}
			_, e = d.Token()
			return "[" + strings.Join(values, ",") + "]", e
		}
		if v == '{' {
			pairs := []pair{}
			seen := map[string]int{}
			for d.More() {
				key, e := d.Token()
				if e != nil {
					return "", e
				}
				s, e := readValue(d, canonical)
				if e != nil {
					return "", e
				}
				k := key.(string)
				if i, ok := seen[k]; ok {
					pairs[i].value = s
				} else {
					seen[k] = len(pairs)
					pairs = append(pairs, pair{k, s})
				}
			}
			_, e = d.Token()
			if e != nil {
				return "", e
			}
			sort.SliceStable(pairs, func(i, j int) bool {
				if canonical {
					return pairs[i].key < pairs[j].key
				}
				a, okA := indexKey(pairs[i].key)
				b, okB := indexKey(pairs[j].key)
				if okA != okB {
					return okA
				}
				return okA && a < b
			})
			parts := []string{}
			for _, p := range pairs {
				parts = append(parts, quote(p.key)+":"+p.value)
			}
			return "{" + strings.Join(parts, ",") + "}", nil
		}
	}
	return "", fmt.Errorf("invalid JSON")
}
func indexKey(s string) (uint64, bool) {
	n, e := strconv.ParseUint(s, 10, 32)
	return n, e == nil && n < 4294967295 && strconv.FormatUint(n, 10) == s
}
func quote(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 32 {
				fmt.Fprintf(&b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}
