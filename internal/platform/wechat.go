package platform

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"
	"xuetangx/internal/fault"
)

const (
	wechatOrigin = Origin
	wechatAPI    = Origin
	wechatWS     = "wss://www.xuetangx.com/wsapp/"
)

// WeChatClient implements the QR login protocol used by xuetangx.com. The
// returned value is a platform Cookie header and must only be handed to the
// encrypted platform-account store.
type WeChatClient struct {
	APIBase      string
	WebSocketURL string
	HTTP         *http.Client
}

func NewWeChatClient() *WeChatClient {
	jar, _ := cookiejar.New(nil)
	return &WeChatClient{
		APIBase:      wechatAPI,
		WebSocketURL: wechatWS,
		HTTP: &http.Client{
			Jar:     jar,
			Timeout: 15 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

// NewWeChatClientForTest uses caller-provided endpoints. It is kept separate
// from production construction so a request cannot redirect this client to an
// arbitrary host through configuration or a user request.
func NewWeChatClientForTest(apiBase, webSocketURL string, client *http.Client) *WeChatClient {
	if client == nil {
		jar, _ := cookiejar.New(nil)
		client = &http.Client{Jar: jar, Timeout: 5 * time.Second}
	}
	return &WeChatClient{APIBase: strings.TrimRight(apiBase, "/"), WebSocketURL: webSocketURL, HTTP: client}
}

type qrLoginMessage struct {
	Op            string `json:"op"`
	Ticket        string `json:"ticket"`
	Token         string `json:"token"`
	ExpireSeconds int    `json:"expire_seconds"`
}

type qrLoginRequest struct {
	Op      string `json:"op"`
	Role    string `json:"role"`
	Version string `json:"version"`
	Purpose string `json:"purpose"`
	XTBZ    string `json:"xtbz"`
	XClient string `json:"x-client"`
}

type qrLoginResponse struct {
	Success   bool            `json:"success"`
	Message   string          `json:"msg"`
	ErrorCode json.RawMessage `json:"error_code"`
}

// Login waits for one QR scan and exchanges the resulting one-time token for
// the xuetangx.com session cookies. onQR is called once after the QR becomes
// available and may be used to update a waiting UI.
func (c *WeChatClient) Login(ctx context.Context, onQR func(string, time.Time)) (string, error) {
	if c == nil || c.HTTP == nil || c.APIBase == "" || c.WebSocketURL == "" {
		return "", fault.New("PLATFORM_LOGIN_UNAVAILABLE", "微信登录服务未配置")
	}
	if err := c.prepare(ctx); err != nil {
		return "", err
	}
	conn, _, err := websocket.Dial(ctx, c.WebSocketURL, &websocket.DialOptions{
		HTTPClient: c.HTTP,
		HTTPHeader: http.Header{
			"Origin":     []string{wechatOrigin},
			"User-Agent": []string{platformUserAgent},
		},
	})
	if err != nil {
		return "", fault.New("PLATFORM_LOGIN_FAILED", "无法连接学堂在线微信登录服务")
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	request := qrLoginRequest{Op: "requestlogin", Role: "web", Version: "1.4", Purpose: "login", XTBZ: "xt", XClient: "web"}
	b, _ := json.Marshal(request)
	if err = conn.Write(ctx, websocket.MessageText, b); err != nil {
		return "", fault.New("PLATFORM_LOGIN_FAILED", "无法请求微信登录二维码")
	}
	for {
		_, raw, readErr := conn.Read(ctx)
		if readErr != nil {
			if errors.Is(readErr, context.Canceled) || errors.Is(readErr, context.DeadlineExceeded) {
				return "", readErr
			}
			return "", fault.New("PLATFORM_LOGIN_FAILED", "微信扫码连接已中断，请重新扫码")
		}
		var msg qrLoginMessage
		if json.Unmarshal(raw, &msg) != nil {
			continue
		}
		switch msg.Op {
		case "requestlogin":
			if !validQRCode(msg.Ticket) {
				return "", fault.New("PLATFORM_LOGIN_FAILED", "学堂在线返回了无效的微信二维码")
			}
			expires := time.Now().Add(time.Duration(msg.ExpireSeconds) * time.Second)
			if msg.ExpireSeconds <= 0 {
				expires = time.Now().Add(60 * time.Second)
			}
			if onQR != nil {
				onQR(msg.Ticket, expires)
			}
		case "loginsuccess":
			if strings.TrimSpace(msg.Token) == "" {
				return "", fault.New("PLATFORM_LOGIN_FAILED", "微信登录令牌为空")
			}
			return c.exchange(ctx, msg.Token)
		}
	}
}

func (c *WeChatClient) prepare(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(c.APIBase, "/")+"/", nil)
	if err != nil {
		return fault.New("PLATFORM_LOGIN_FAILED", "无法初始化学堂在线登录会话")
	}
	req.Header.Set("User-Agent", platformUserAgent)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fault.New("PLATFORM_LOGIN_FAILED", "无法连接学堂在线")
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 400 {
		return fault.New("PLATFORM_LOGIN_FAILED", "学堂在线暂时无法登录")
	}
	return nil
}

func (c *WeChatClient) exchange(ctx context.Context, token string) (string, error) {
	data, _ := json.Marshal(map[string]string{"s_s": token})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.APIBase, "/")+"/api/v1/u/login/wx/", strings.NewReader(string(data)))
	if err != nil {
		return "", fault.New("PLATFORM_LOGIN_FAILED", "无法提交微信登录结果")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Origin", wechatOrigin)
	req.Header.Set("Referer", wechatOrigin+"/")
	req.Header.Set("User-Agent", platformUserAgent)
	req.Header.Set("app-name", "xtzx")
	req.Header.Set("terminal-type", "web")
	req.Header.Set("django-language", "zh-hans")
	req.Header.Set("Accept-Language", "zh-hans")
	req.Header.Set("xtbz", "xt")
	req.Header.Set("x-client", "web")
	if c.HTTP.Jar != nil {
		if parsed, parseErr := url.Parse(c.APIBase); parseErr == nil {
			for _, cookie := range c.HTTP.Jar.Cookies(parsed) {
				if cookie.Name == "csrftoken" {
					req.Header.Set("X-CSRFToken", cookie.Value)
					break
				}
			}
		}
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return "", fault.New("PLATFORM_LOGIN_FAILED", "学堂在线未能确认微信登录")
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", fault.New("PLATFORM_LOGIN_FAILED", "学堂在线登录响应无效")
	}
	var result qrLoginResponse
	if json.Unmarshal(b, &result) != nil || resp.StatusCode < 200 || resp.StatusCode >= 300 || !result.Success {
		return "", fault.New("PLATFORM_LOGIN_FAILED", "学堂在线未接受本次微信登录")
	}
	return c.cookieHeader()
}

func (c *WeChatClient) cookieHeader() (string, error) {
	u, err := url.Parse(c.APIBase)
	if err != nil {
		return "", fault.New("PLATFORM_LOGIN_FAILED", "学堂在线登录地址无效")
	}
	if c.HTTP.Jar == nil {
		return "", fault.New("PLATFORM_LOGIN_FAILED", "学堂在线未返回登录 Cookie")
	}
	cookies := c.HTTP.Jar.Cookies(u)
	parts := make([]string, 0, len(cookies))
	hasSession, hasCSRF := false, false
	for _, cookie := range cookies {
		if cookie.Name == "sessionid" && cookie.Value != "" {
			hasSession = true
		}
		if cookie.Name == "csrftoken" && cookie.Value != "" {
			hasCSRF = true
		}
		if cookie.Name != "" && cookie.Value != "" {
			parts = append(parts, cookie.Name+"="+cookie.Value)
		}
	}
	if !hasSession || !hasCSRF {
		return "", fault.New("PLATFORM_LOGIN_FAILED", "学堂在线未返回完整登录 Cookie")
	}
	return strings.Join(parts, "; "), nil
}

func validQRCode(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.Host == "mp.weixin.qq.com" && u.Path == "/cgi-bin/showqrcode" && u.Query().Get("ticket") != ""
}

const platformUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
