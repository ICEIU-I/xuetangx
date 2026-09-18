package httpapi

import (
	"net/http"
	"strings"
	"unicode/utf8"
	"xuetangx/internal/fault"
)

func searchQuery(r *http.Request) (string, error) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if utf8.RuneCountInString(q) > 200 {
		return "", fault.New("INVALID_INPUT", "搜索内容不能超过 200 字")
	}
	return q, nil
}
