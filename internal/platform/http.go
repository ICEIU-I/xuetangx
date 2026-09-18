package platform

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"strings"
	"time"
	"xuetangx/internal/fault"
	"xuetangx/internal/platform/wire"
)

const Origin = "https://www.xuetangx.com"
const SubmitPath = "/api/v1/lms/exercise/problem_apply/"

type Response struct {
	Status     int             `json:"status"`
	JSON       wire.Object     `json:"json"`
	RetryAfter string          `json:"retryAfter"`
	Raw        json.RawMessage `json:"raw,omitempty"`
}
type TransportError struct {
	Connected, Transient bool
	Cause                error
}

func (e *TransportError) Error() string { return "平台网络连接中断，结果需要核对" }
func (e *TransportError) Unwrap() error { return e.Cause }

type Transport interface {
	Do(context.Context, string, string, any, string) (Response, error)
}
type Client struct {
	base        string
	read, write *http.Client
}

func NewClient() *Client { return newClient(Origin) }

// NewTestClient only accepts loopback simulators. Production wiring never takes a platform URL from a request or environment.
func NewTestClient(base string) (*Client, error) {
	u, e := url.Parse(base)
	if e != nil || u.Scheme != "http" || net.ParseIP(u.Hostname()) == nil || !net.ParseIP(u.Hostname()).IsLoopback() {
		return nil, fmt.Errorf("test platform must be loopback")
	}
	return newClient(base), nil
}
func newClient(base string) *Client {
	read := http.DefaultTransport.(*http.Transport).Clone()
	read.MaxConnsPerHost = 32
	write := read.Clone()
	write.DisableKeepAlives = true
	makeClient := func(t *http.Transport) *http.Client {
		return &http.Client{Transport: t, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	return &Client{base, makeClient(read), makeClient(write)}
}
func ReadOnly(method, path string) bool {
	path = strings.Split(path, "?")[0]
	if method == "POST" {
		return path == "/api/v1/lms/learn/chapter/schedule"
	}
	if method != "GET" {
		return false
	}
	for _, prefix := range []string{"/api/v1/lms/product/get_product_basic_info/", "/api/v1/lms/product/classroom/", "/api/v1/lms/product/sku_pay_detail/", "/api/v1/u/user/basic_profile/", "/api/v1/lms/user/user-courses/", "/api/v1/lms/learn/leaf_info/", "/api/v1/lms/learn/course/", "/api/v1/lms/exercise/get_exercise_list/", "/api/v1/lms/service/playurl/", "/api/v1/lms/forum/unit/discussion/", "/video-log/get_video_watch_progress/"} {
		if strings.HasPrefix(path, prefix) {
			return true
		}
	}
	return false
}
func (c *Client) Do(ctx context.Context, method, path string, body any, cookie string) (Response, error) {
	if (method != "GET" && method != "POST") || !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") || strings.ContainsAny(path, "\r\n") {
		return Response{}, fault.New("INVALID_REQUEST", "平台请求路径无效")
	}
	u, e := url.Parse(path)
	if e != nil || u.IsAbs() || u.Host != "" {
		return Response{}, fault.New("INVALID_REQUEST", "平台请求路径无效")
	}
	var data []byte
	if body != nil {
		data, e = json.Marshal(body)
		if e != nil {
			return Response{}, e
		}
	}
	connected := false
	trace := &httptrace.ClientTrace{GotConn: func(i httptrace.GotConnInfo) { connected = true }, TLSHandshakeDone: func(_ tls.ConnectionState, e error) {
		if e == nil {
			connected = true
		}
	}}
	req, e := http.NewRequestWithContext(httptrace.WithClientTrace(ctx, trace), method, c.base+path, bytes.NewReader(data))
	if e != nil {
		return Response{}, e
	}
	req.Header.Set("Cookie", cookie)
	req.Header.Set("Referer", Origin+"/")
	req.Header.Set("User-Agent", "Mozilla/5.0 Chrome/120.0 Safari/537.36")
	req.Header.Set("xtbz", "xt")
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	if method == "POST" {
		req.Header.Set("Content-Type", "application/json")
		for _, part := range strings.Split(cookie, ";") {
			key, val, ok := strings.Cut(strings.TrimSpace(part), "=")
			if ok && key == "csrftoken" {
				req.Header.Set("X-CSRFToken", val)
			}
		}
	}
	client := c.write
	if ReadOnly(method, path) {
		client = c.read
	}
	resp, e := client.Do(req)
	if e != nil {
		var netErr net.Error
		transient := errors.As(e, &netErr) || errors.Is(e, io.EOF) || errors.Is(e, io.ErrUnexpectedEOF)
		return Response{}, &TransportError{connected, transient, e}
	}
	defer resp.Body.Close()
	b, e := io.ReadAll(io.LimitReader(resp.Body, 8*1024*1024+1))
	if e != nil {
		return Response{}, &TransportError{true, true, e}
	}
	if len(b) > 8*1024*1024 {
		return Response{}, fault.New("REMOTE_ERROR", "平台响应过大")
	}
	obj, _ := wire.Decode(b)
	r := Response{Status: resp.StatusCode, JSON: obj, RetryAfter: resp.Header.Get("Retry-After")}
	if json.Valid(b) {
		r.Raw = b
	}
	return r, nil
}
func (r Response) Data() (wire.Object, error) {
	if r.Status == 401 {
		return nil, fault.New("ACCOUNT_REQUIRED", "平台登录已失效")
	}
	if r.Status == 403 {
		return nil, fault.New("ACCESS_DENIED", "平台拒绝访问（HTTP 403）")
	}
	if RateLimited(r) {
		return nil, fault.New("RATE_LIMITED", "平台返回限流，请等待后继续")
	}
	code := wire.String(r.JSON["code"])
	if r.Status != 200 || r.JSON == nil || r.JSON["success"] == false || (code != "" && code != "0") {
		return nil, fault.New("REMOTE_ERROR", fmt.Sprintf("平台请求失败（HTTP %d）", r.Status))
	}
	if v, ok := r.JSON["data"]; ok {
		return wire.Obj(v), nil
	}
	return r.JSON, nil
}
func (c *Client) Authenticate(ctx context.Context, cookie string) (int64, string, error) {
	r, e := c.Do(ctx, "GET", "/api/v1/u/user/basic_profile/", nil, cookie)
	if e != nil {
		return 0, "", e
	}
	d, e := r.Data()
	if e != nil {
		return 0, "", e
	}
	id := d["user_id"]
	if id == nil {
		id = d["id"]
	}
	n, e := wire.ID(id)
	return n, wire.String(d["name"]), e
}
