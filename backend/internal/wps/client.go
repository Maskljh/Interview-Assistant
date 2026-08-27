package wps

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// 默认 WPS 365 开放平台 API 基础域名。
const defaultAPIBase = "https://openapi.wps.cn"

// TokenProvider 提供用户当前可用的 WPS access_token（由 wpsoauth.Handler 实现，
// 负责过期自动刷新）。返回空串表示无可用凭证。
type TokenProvider interface {
	TokenForUser(ctx context.Context, userID int64) (string, error)
}

// ErrNoToken 表示用户没有可用的 WPS 授权凭证（未授权或 token 失效）。
var ErrNoToken = errors.New("wps token unavailable")

// Client 封装对 WPS 365 开放平台业务 API 的调用。
type Client struct {
	apiBase string
	httpDo  func(req *http.Request) (*http.Response, error)
}

func NewClient() *Client {
	return &Client{apiBase: defaultAPIBase, httpDo: http.DefaultClient.Do}
}

// APIError 是 WPS 开放平台的统一错误响应体（导出供其它包识别权限类错误）。
type APIError struct {
	Code int    `json:"code"`
	Msg  string `json:"msg"`
}

func (e *APIError) Error() string {
	if e.Msg != "" {
		return e.Msg
	}
	return fmt.Sprintf("wps api error code=%d", e.Code)
}

// do 发送一个携带 Bearer token 的 JSON 请求并解析响应。
// out 为可选的响应体反序列化目标（透传整个响应体 JSON）。
// 返回 WPS code 字段（0 或 200 表示成功）。
func (c *Client) do(ctx context.Context, token, method, path string, query url.Values, body any, out any) error {
	var reqBody io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reqBody = strings.NewReader(string(raw))
	}

	u := c.apiBase + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u, reqBody)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("User-Agent", "interview-assistant/1.0")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.httpDo(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}

	// 业务响应统一 {code, msg, data}；HTTP 非 2xx 也照常解析 code。
	var envelope struct {
		Code int             `json:"code"`
		Msg  string          `json:"msg"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("wps request failed: http %d %s", resp.StatusCode, truncate(string(raw), 200))
		}
		return fmt.Errorf("wps response parse: %s", truncate(string(raw), 200))
	}
	if envelope.Code != 0 && envelope.Code != 200 {
		// 403/权限类错误透出具体文案，便于前端给出「权限未开通」引导。
		if resp.StatusCode == http.StatusForbidden || strings.Contains(envelope.Msg, "权限") {
			return &APIError{Code: envelope.Code, Msg: envelope.Msg}
		}
		return &APIError{Code: envelope.Code, Msg: envelope.Msg}
	}
	if out != nil && len(envelope.Data) > 0 {
		if err := json.Unmarshal(envelope.Data, out); err != nil {
			return err
		}
	}
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
