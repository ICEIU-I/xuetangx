// Package wire decodes the platform's inconsistent scalar representations.
package wire

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
)

type Object map[string]any

func Decode(b []byte) (Object, error) {
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	var v Object
	e := d.Decode(&v)
	if v == nil && e == nil {
		e = fmt.Errorf("expected object")
	}
	return v, e
}
func Obj(v any) Object {
	switch v := v.(type) {
	case map[string]any:
		return v
	case Object:
		return v
	}
	return Object{}
}
func Array(v any) []any { a, _ := v.([]any); return a }
func String(v any) string {
	switch v := v.(type) {
	case string:
		return v
	case json.Number:
		return string(v)
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(v)
	case int:
		return strconv.Itoa(v)
	case int64:
		return strconv.FormatInt(v, 10)
	}
	return ""
}
func Number(v any) (float64, bool) {
	s := String(v)
	if _, b := v.(bool); b || s == "" {
		return 0, false
	}
	n, e := strconv.ParseFloat(s, 64)
	return n, e == nil && !math.IsNaN(n) && !math.IsInf(n, 0)
}
func Int(v any) (int64, bool) {
	n, ok := Number(v)
	return int64(n), ok && math.Trunc(n) == n && math.Abs(n) <= 9007199254740991
}
func ID(v any) (int64, error) {
	n, ok := Int(v)
	if !ok || n <= 0 {
		return 0, fmt.Errorf("invalid platform identifier")
	}
	return n, nil
}
func True(v any) bool { return v == true || String(v) == "1" }
func Truthy(v any) bool {
	if v == nil || v == false || v == "" {
		return false
	}
	if n, ok := Number(v); ok {
		return n != 0
	}
	return true
}
func JSON(v any) json.RawMessage { b, _ := json.Marshal(v); return b }
func ObjFromJSON(v any) Object   { o, _ := Decode(JSON(v)); return o }
